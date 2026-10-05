//! 首页解析与热门榜单刷新策略；不执行页面脚本。
use super::*;

pub(super) const HOME_URL: &str = "https://www.skills.sh/";
const TTL: u64 = 600;
const CAP: u64 = 8 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Attempt {
    generation: u64,
    at: Option<u64>,
    failure: Option<NetFailure>,
}

// 只解析 script 内容中的 JSON 字符串，不执行 JavaScript。
pub(super) fn parse(body: &[u8]) -> Option<Vec<SkillHit>> {
    let html = std::str::from_utf8(body).ok()?;
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        rest = &rest[start..];
        let content = rest.find('>')? + 1;
        let end = rest.find("</script>")?;
        let script = &rest[content..end];
        let mut pos = 0;
        while let Some(offset) = script[pos..].find('"') {
            pos += offset;
            let mut stream =
                serde_json::Deserializer::from_str(&script[pos..]).into_iter::<String>();
            if let Some(Ok(decoded)) = stream.next() {
                pos += stream.byte_offset();
                if let Some(hits) = decoded_hits(&decoded) {
                    return Some(hits);
                }
            } else {
                pos += 1;
            }
        }
        rest = &rest[end + "</script>".len()..];
    }
    None
}

fn decoded_hits(decoded: &str) -> Option<Vec<SkillHit>> {
    let marker = "\"initialSkills\"";
    let mut rest = decoded;
    while let Some(at) = rest.find(marker) {
        rest = &rest[at + marker.len()..];
        let array = rest.trim_start().strip_prefix(':')?.trim_start();
        let value = serde_json::Deserializer::from_str(array)
            .into_iter::<Value>()
            .next()?
            .ok()?;
        let skills = value.as_array()?;
        let valid: Vec<Value> = skills
            .iter()
            .filter(|entry| {
                let Some(source) = entry.get("source").and_then(Value::as_str) else {
                    return false;
                };
                // 此目录的契约是 owner/repo；拒绝 URL、子目录和其他来源。
                let parts: Vec<_> = source.split('/').collect();
                parts.len() == 2
                    && parts.iter().all(|part| {
                        !part.is_empty()
                            && *part != "."
                            && *part != ".."
                            && part
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                    })
            })
            .cloned()
            .collect();
        let bytes = serde_json::to_vec(&serde_json::json!({ "skills": valid })).ok()?;
        let mut seen = BTreeSet::new();
        let hits: Vec<_> = parse_skill_search(&bytes)?
            .into_iter()
            .filter(|hit| {
                seen.insert((
                    hit.listing.repo.to_lowercase(),
                    hit.skill_id
                        .clone()
                        .unwrap_or_else(|| hit.listing.name.clone()),
                ))
            })
            .collect();
        if !hits.is_empty() {
            return Some(hits);
        }
    }
    None
}

fn should_refresh(cached_at: Option<u64>, attempt_at: Option<u64>, t: u64, force: bool) -> bool {
    force
        || (!cached_at.is_some_and(|at| fresh(at, t, TTL))
            && !attempt_at.is_some_and(|at| fresh(at, t, TTL)))
}

#[derive(Default)]
pub(super) struct Refresh {
    serial: tokio::sync::Mutex<()>,
    attempt: Mutex<Attempt>,
}

impl Refresh {
    fn meta(
        &self,
        cached: Option<&Cached<Vec<SkillHit>>>,
        t: u64,
    ) -> (PopularMeta, Option<Fallback>) {
        let at = cached.map(|c| c.at);
        let attempt = guard(&self.attempt);
        (
            PopularMeta {
                source: if cached.is_some() {
                    "online"
                } else {
                    "bundled"
                }
                .into(),
                updated_at: at,
                refresh_needed: should_refresh(at, attempt.at, t, false),
            },
            attempt
                .failure
                .as_ref()
                .map(|failure| Fallback::from_failure("skills.sh", at, failure)),
        )
    }

    async fn run<Fut>(
        &self,
        clock: impl Fn() -> u64,
        force: bool,
        cached: impl Fn() -> Option<Cached<Vec<SkillHit>>>,
        save: impl FnOnce(Cached<Vec<SkillHit>>),
        fetch: impl FnOnce() -> Fut,
    ) where
        Fut: std::future::Future<Output = Result<Vec<SkillHit>, NetFailure>>,
    {
        let generation = guard(&self.attempt).generation;
        let _serial = self.serial.lock().await;
        let at = cached().filter(|c| !c.items.is_empty()).map(|c| c.at);
        {
            let attempt = guard(&self.attempt);
            if attempt.generation != generation || !should_refresh(at, attempt.at, clock(), force) {
                return;
            }
        }
        let result = fetch().await;
        let completed_at = clock();
        let failure = match result {
            Ok(items) if !items.is_empty() => {
                save(Cached {
                    at: completed_at,
                    items,
                });
                None
            }
            Ok(_) => Some(NetFailure {
                error: NetError::Unreadable,
                detail: "the popular list came back empty".into(),
            }),
            Err(error) => Some(error),
        };
        let mut attempt = guard(&self.attempt);
        attempt.generation += 1;
        attempt.at = Some(completed_at);
        attempt.failure = failure;
    }
}

pub(super) fn cached_result(
    market: &MarketState,
    t: u64,
) -> (Vec<SkillHit>, Option<Fallback>, PopularMeta) {
    let cached = market
        .with_cache(|cache| cache.popular.clone())
        .filter(|c| !c.items.is_empty());
    let (meta, fallback) = market.popular_refresh.meta(cached.as_ref(), t);
    let hits = cached
        .map(|c| c.items)
        .unwrap_or_else(|| snapshot_matching(sophia_core::market::popular_snapshot(), ""));
    (hits, fallback, meta)
}

async fn fetch(market: &MarketState, url: &str) -> Result<Vec<SkillHit>, NetFailure> {
    // 用客户端自带的 `Sophia/版本` 如实标明身份（2026-09-29 实测首页对它照常返回 200 与 initialSkills）
    let response =
        market.client()?.get(url).send().await.map_err(|e| {
            NetFailure::new(kind_of(&e, NetError::Network), url, &error_chain_text(&e))
        })?;
    let response = check_status(response).await?;
    let body = MarketState::read_capped(response, CAP).await?;
    parse(&body).ok_or_else(|| NetFailure::unreadable(url, "page has no usable skills list", &body))
}

pub(super) async fn refresh(market: &MarketState, force: bool, url: &str) {
    market
        .popular_refresh
        .run(
            now,
            force,
            || market.with_cache(|c| c.popular.clone()),
            |cached| market.update_cache(|c| c.popular = Some(cached)),
            || fetch(market, url),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ac4_decodes_unicode_escapes_filters_sources_and_deduplicates() {
        let hits = parse(include_bytes!("fixtures/popular.html")).expect("首页榜单");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].skill_id.as_deref(), Some("react:components"));
        assert_eq!(hits[0].listing.name, "幻灯片 \"PPT\" \\ 示例 😀");
        assert_eq!(hits[0].listing.installs, 123);
        assert_eq!(hits[1].listing.repo, "other/repo");
    }

    #[test]
    fn ac3_empty_or_malformed_page_is_failure() {
        assert!(parse(b"<html>blocked</html>").is_none());
        assert!(parse(b"<script>\"{\\\"initialSkills\\\":[]}\"</script>").is_none());
        assert!(parse(b"<script>\"{\\\"initialSkills\\\":[}\"</script>").is_none());
    }

    fn fixture_hits() -> Vec<SkillHit> {
        parse(include_bytes!("fixtures/popular.html")).unwrap()
    }

    #[test]
    fn ac1_old_disk_cache_remains_compatible() {
        let old: DiskCache =
            serde_json::from_str(r#"{"skills":{},"mcp":{},"updates":null}"#).unwrap();
        assert!(old.popular.is_none());
        let cache = DiskCache {
            popular: Some(Cached {
                at: 10,
                items: fixture_hits(),
            }),
            ..old
        };
        let loaded: DiskCache =
            serde_json::from_slice(&serde_json::to_vec(&cache).unwrap()).unwrap();
        assert_eq!(loaded.popular, cache.popular);
    }

    #[test]
    fn ac2_ttl_boundary_and_manual_refresh() {
        let cached = Cached {
            at: 1000,
            items: fixture_hits(),
        };
        assert!(!should_refresh(Some(cached.at), None, 1599, false));
        assert!(should_refresh(Some(cached.at), None, 1600, false));
        assert!(should_refresh(Some(cached.at), Some(1599), 1599, true));
        assert!(!should_refresh(None, Some(1000), 1599, false));
        assert!(should_refresh(None, Some(1000), 1600, false));
    }

    #[test]
    fn ac1_cached_source_metadata() {
        let state = MarketState {
            cache: Mutex::new(Some(DiskCache::default())),
            ..Default::default()
        };
        let (hits, fallback, meta) = cached_result(&state, 700);
        assert!(!hits.is_empty());
        assert!(fallback.is_none());
        assert_eq!(meta.source, "bundled");
        assert!(meta.updated_at.is_none());
        assert!(meta.refresh_needed);
        let hits = parse(include_bytes!("fixtures/popular.html")).unwrap();
        state.with_cache(|cache| {
            cache.popular = Some(Cached {
                at: 100,
                items: hits.clone(),
            })
        });
        let (actual, _, meta) = cached_result(&state, 699);
        assert_eq!(actual, hits);
        assert_eq!(meta.source, "online");
        assert_eq!(meta.updated_at, Some(100));
        assert!(!meta.refresh_needed);
        assert!(cached_result(&state, 700).2.refresh_needed);
        let json = serde_json::to_value(meta).unwrap();
        assert_eq!(json["updatedAt"], 100);
        assert_eq!(json["refreshNeeded"], false);
    }

    #[test]
    fn ac3_failure_preserves_cache_and_concurrent_refresh_is_coalesced() {
        use std::io::{Read, Write};
        for (status, body, limited) in [
            (429, "", true),
            (503, "unavailable", false),
            (200, "<html>verification required</html>", false),
            (200, r#"<script>"{\"initialSkills\":[]}"</script>"#, false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let requests = Arc::new(AtomicU64::new(0));
            let count = requests.clone();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                count.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(80));
                let response = format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            });
            let hits = parse(include_bytes!("fixtures/popular.html")).unwrap();
            let state = MarketState {
                cache: Mutex::new(Some(DiskCache {
                    popular: Some(Cached {
                        at: 100,
                        items: hits.clone(),
                    }),
                    ..Default::default()
                })),
                ..Default::default()
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                tokio::join!(refresh(&state, true, &url), refresh(&state, true, &url));
                // 自动重试在失败冷却中，即使旧数据已过期，也不再请求。
                refresh(&state, false, &url).await;
            });
            server.join().unwrap();
            assert_eq!(requests.load(Ordering::Relaxed), 1);
            let (actual, fallback, meta) = cached_result(&state, now());
            assert_eq!(actual, hits);
            assert_eq!(meta.updated_at, Some(100));
            assert!(!meta.refresh_needed);
            let fallback = fallback.unwrap();
            assert_eq!(fallback.rate_limited, limited);
            // 读不懂的页面不再说成连不上（R10）
            if status == 200 {
                assert_eq!(
                    fallback.reason.as_deref(),
                    Some("skills.sh 返回的内容读不懂")
                );
            }
            assert!(fallback
                .detail
                .is_some_and(|d| d.starts_with("GET http://127.0.0.1:")));
            state.with_cache(|cache| cache.popular = None);
            let (actual, fallback, meta) = cached_result(&state, now());
            assert!(!actual.is_empty());
            assert_eq!(meta.source, "bundled");
            assert!(fallback.is_some());
        }
    }

    #[test]
    fn ac2_completed_timestamp_and_failure_cooldown() {
        tauri::async_runtime::block_on(async {
            let coordinator = Refresh::default();
            let clock = AtomicU64::new(1000);
            let cached = Mutex::new(None);
            coordinator
                .run(
                    || clock.load(Ordering::SeqCst),
                    false,
                    || guard(&cached).clone(),
                    |value| *guard(&cached) = Some(value),
                    || async {
                        clock.store(1030, Ordering::SeqCst);
                        Ok(fixture_hits())
                    },
                )
                .await;
            assert_eq!(guard(&cached).as_ref().unwrap().at, 1030);
            let failed = Refresh::default();
            clock.store(2000, Ordering::SeqCst);
            failed
                .run(
                    || clock.load(Ordering::SeqCst),
                    false,
                    || None,
                    |_| panic!("失败不得写缓存"),
                    || async {
                        clock.store(2030, Ordering::SeqCst);
                        Err(NetFailure::new(NetError::Network, "http://x/", "refused"))
                    },
                )
                .await;
            assert!(!failed.meta(None, 2629).0.refresh_needed);
            assert!(failed.meta(None, 2630).0.refresh_needed);
        });
    }

    #[test]
    fn ac2_successful_concurrent_manual_refresh_is_coalesced() {
        tauri::async_runtime::block_on(async {
            let coordinator = Refresh::default();
            let cached = Mutex::new(None);
            let requests = AtomicU64::new(0);
            let work = || {
                coordinator.run(
                    || 1000,
                    true,
                    || guard(&cached).clone(),
                    |value| *guard(&cached) = Some(value),
                    || async {
                        requests.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Ok(fixture_hits())
                    },
                )
            };
            tokio::join!(work(), work(), work());
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            assert_eq!(guard(&cached).as_ref().unwrap().items.len(), 2);
            // 单独的后续手动操作仍越过新鲜缓存。
            work().await;
            assert_eq!(requests.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn ac3_empty_fetch_cannot_replace_cached_list() {
        tauri::async_runtime::block_on(async {
            let coordinator = Refresh::default();
            let cached = Cached {
                at: 100,
                items: fixture_hits(),
            };
            coordinator
                .run(
                    || 1000,
                    true,
                    || Some(cached.clone()),
                    |_| panic!("空榜单不得写缓存"),
                    || async { Ok(vec![]) },
                )
                .await;
            let (meta, fallback) = coordinator.meta(Some(&cached), 1000);
            assert_eq!(meta.source, "online");
            assert_eq!(meta.updated_at, Some(100));
            assert!(fallback.is_some());
            assert!(!meta.refresh_needed);
        });
    }

    #[test]
    #[ignore = "requires live skills.sh access"]
    fn live_popular_smoke() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let hits = runtime
            .block_on(fetch(&MarketState::default(), HOME_URL))
            .unwrap();
        assert!(hits.len() >= 50);
        assert!(hits.iter().all(|hit| hit.skill_id.is_some()));
        println!(
            "skills.sh Rust fetch: {} valid skills; first={}/{}",
            hits.len(),
            hits[0].listing.repo,
            hits[0].listing.name
        );
    }
}
