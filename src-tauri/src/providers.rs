//! 全局模型提供商页的命令（#252，ADR 0003）：加一家、改、重拉模型、启用 / 取消启用、手填 id、删。
//! 名单与密钥的读写在 `sophia_core::model_providers::book`；联网（拉模型、试调）用 `sophia_gateway::runtime`，
//! 都放在拿锁之外。
//!
//! #259 起各 agent 从这份名单里选模型。启用与选是两步（2026-10-08，ADR 0003 修订）：这里启用的只进这一家的
//! 已启用名单，不选进任何 agent；删一家、取消启用、改地址之后开着的 agent 照新名单重写（`App::models_changed`）。
//! 那一步会写 Codex、Claude 的配置，所以在 `config_lock` 里做；只动名单的那一步不取它。
use crate::gateway::blocking;
use crate::AppState;
use sophia_core::codex_models::catalog::Model;
use sophia_core::model_providers::book::Book;
use sophia_core::model_providers::view::{self, ProviderRow};
use sophia_core::model_providers::{preview, Added, NewProvider, Preview, Provider, ProviderError};
use sophia_core::provider_presets::ProviderPreset;
use sophia_gateway::app::{clean_base_url, AppError, ProbeTarget};
use sophia_gateway::router::{KeyVerdict, Protocol};
use sophia_gateway::runtime;

fn book() -> Result<Book, AppError> {
    let dir = crate::runtime_store_dir().map_err(|e| AppError::new("internal", e))?;
    Ok(Book::new(&dir))
}

fn app_error(e: ProviderError) -> AppError {
    AppError::new(e.code(), e.to_string())
}

/// 当前的名单，按页面要的样子（每一行带上选了它的 agent）
fn current() -> Result<Vec<ProviderRow>, AppError> {
    let book = book()?;
    let list = book.load().map_err(app_error)?;
    let picks = list.all_picks();
    Ok(view::rows(&list, |id| book.key(id), &picks))
}

fn provider(id: &str) -> Result<(Provider, String), AppError> {
    let book = book()?;
    let found = book
        .load()
        .map_err(app_error)?
        .provider(id)
        .cloned()
        .ok_or_else(|| app_error(ProviderError::Unknown(id.to_owned())))?;
    let key = book
        .key(id)
        .map_err(|e| AppError::new("invalid", e.to_string()))?
        .ok_or_else(|| AppError::new("invalid", sophia_core::t!("models.app.noKey")))?;
    Ok((found, key))
}

/// 名称撞了就在联网之前拦下（存的时候还会再查一遍）
fn ensure_name_free(name: &str, except: Option<&str>) -> Result<(), AppError> {
    let list = book()?.load().map_err(app_error)?;
    match list.name_taken(name, except) {
        Some(taken) => Err(app_error(ProviderError::NameTaken(taken.name.clone()))),
        None => Ok(()),
    }
}

async fn fetch(base_url: &str, key: &str) -> Result<(Vec<Model>, String), String> {
    runtime::fetch_models(base_url, key).await.map_err(|e| {
        log::warn!("拉模型提供商 {base_url} 的模型失败：{e}");
        sophia_core::report::count_error_code(e.code);
        e.to_string()
    })
}

/// 名单变了之后让开着的 agent 跟上（删一家、取消启用、改地址、重拉换了接口基址）；没跟上的只记日志
async fn follow(state: &tauri::State<'_, AppState>) {
    let Some(app) = state.gateway.clone() else {
        return;
    };
    let _guard = state.config_lock.lock().await;
    match blocking(move || Ok(app.models_changed())).await {
        Ok(warnings) => {
            for warning in warnings {
                log::warn!("名单变了之后跟上：{warning}");
            }
        }
        Err(e) => log::warn!("名单变了之后跟上失败：{e}"),
    }
}

#[tauri::command]
pub async fn providers_list() -> Result<Vec<ProviderRow>, String> {
    blocking(current).await
}

/// 加一家之后：结论（启用了几个、按哪条规则）与新的名单
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedState {
    added: Added,
    providers: Vec<ProviderRow>,
}

/// 添加弹窗里填好密钥后拉到的列表（不落盘）：对话模型、按默认规则先勾上哪些、用了哪条规则，
/// 和拉模型时探明的接口基址（框底手填 id 试调用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    #[serde(flatten)]
    preview: Preview,
    api_base: String,
}

/// 添加弹窗：用表单里的地址与密钥拉模型列表，按默认规则先勾好（画板第 9 屏 ②③④）。只读：不写 settings、
/// 不写密钥文件；拉不到也不计数（用户在弹窗里粘贴、改密钥时会拉好几次，没保存的不算出错）
#[tauri::command]
pub async fn providers_preview(
    base_url: String,
    key: String,
    preset: Option<String>,
) -> Result<PreviewState, String> {
    let cleaned = clean_base_url(&base_url).map_err(|e| e.to_string())?;
    let (fetched, api_base) = runtime::fetch_models(&cleaned, key.trim())
        .await
        .map_err(|e| {
            log::info!("preview-models {cleaned}: {e}");
            e.to_string()
        })?;
    let recommended = preset_of(preset.as_deref())
        .map(|p| p.recommended_models)
        .unwrap_or_default();
    Ok(PreviewState {
        preview: preview(fetched, &recommended),
        api_base,
    })
}

/// 添加弹窗框底手填 id：用表单里的密钥先试一次（还没保存，不记密钥结论），通了界面才把它勾上
#[tauri::command]
pub async fn providers_probe_draft(
    api_base: String,
    key: String,
    preset: Option<String>,
    model: String,
) -> Result<(), String> {
    let model = model.trim().to_owned();
    if model.is_empty() {
        return Err(app_error(ProviderError::NoModel).to_string());
    }
    let target = ProbeTarget {
        api_base: api_base.trim().trim_end_matches('/').to_owned(),
        protocol: if preset_protocol(preset_of(preset.as_deref()).as_ref()) == "responses" {
            Protocol::Responses
        } else {
            Protocol::Chat
        },
        model,
        key: key.trim().to_owned(),
    };
    runtime::probe_target(&target).await.map_err(|e| {
        log::info!("probe-draft {} {}: {e}", target.api_base, target.model);
        e.to_string()
    })
}

fn preset_of(preset: Option<&str>) -> Option<ProviderPreset> {
    preset
        .filter(|p| !p.trim().is_empty())
        .and_then(sophia_core::provider_presets::find)
}

/// 预设给的协议（`chat` / `responses`）；手填地址的是 `chat`
fn preset_protocol(found: Option<&ProviderPreset>) -> String {
    found
        .and_then(|p| p.openai.as_ref())
        .and_then(|e| e.protocol.clone())
        .unwrap_or_else(|| "chat".to_owned())
}

/// 加一家：选预设只填密钥（名称预设填好可改），自定义的另填名称和地址。名称为空取地址主体；同名拒绝。
/// 先用密钥拉模型（失败什么都不存），再启用：`enabled` 是添加弹窗里用户勾定的（不传按默认规则：预设的推荐模型 →
/// 全开 → 一个不开）。启用的不选进任何 agent（新的一家还没有 agent 在用，不用跟上）
#[tauri::command]
pub async fn providers_add(
    name: String,
    base_url: String,
    key: String,
    preset: Option<String>,
    enabled: Option<Vec<String>>,
) -> Result<AddedState, String> {
    let cleaned = clean_base_url(&base_url).map_err(|e| e.to_string())?;
    let key = key.trim().to_owned();
    let check = name.clone();
    blocking(move || ensure_name_free(&check, None)).await?;
    let found = preset_of(preset.as_deref());
    let (fetched, api_base) = fetch(&cleaned, &key).await?;
    let new = NewProvider {
        name,
        base_url: cleaned,
        api_base,
        protocol: preset_protocol(found.as_ref()),
        preset: found.as_ref().map(|p| p.id.clone()),
        fetched,
        recommended: found.map(|p| p.recommended_models).unwrap_or_default(),
        chosen: enabled,
    };
    let added = blocking(move || book()?.add(new, &key).map_err(app_error)).await?;
    Ok(AddedState {
        added,
        providers: blocking(current).await?,
    })
}

/// 改名称、地址；`key` 不空时先用它在新地址上拉模型（失败什么都不改），再一并存密钥、并入模型。
/// 只改了地址、用已存的密钥时由界面接着调 `providers_refetch`。改完开着的 agent 照新地址跟上
#[tauri::command]
pub async fn providers_edit(
    id: String,
    name: String,
    base_url: String,
    key: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProviderRow>, String> {
    let cleaned = clean_base_url(&base_url).map_err(|e| e.to_string())?;
    let (check, except) = (name.clone(), id.clone());
    blocking(move || ensure_name_free(&check, Some(&except))).await?;
    let key = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    let fetched = match &key {
        Some(key) => Some(fetch(&cleaned, key).await?),
        None => None,
    };
    blocking(move || {
        let with_key = match (&key, fetched) {
            (Some(key), Some((models, api_base))) => Some((key.clone(), models, api_base)),
            _ => None,
        };
        book()?
            .edit(
                &id,
                Some(&name),
                &cleaned,
                with_key
                    .as_ref()
                    .map(|(k, m, a)| (k.as_str(), m.clone(), a.as_str())),
            )
            .map_err(app_error)
    })
    .await?;
    follow(&state).await;
    blocking(current).await
}

/// 重新拉这一家的模型列表；拉不到时把原因记在那一行上，再报错。接口基址变了，开着的 agent 跟上
#[tauri::command]
pub async fn providers_refetch(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProviderRow>, String> {
    let target = id.clone();
    let (found, key) = blocking(move || provider(&target)).await?;
    match runtime::fetch_models_detailed(&found.base_url, &key).await {
        Ok((models, api_base)) => {
            blocking(move || {
                book()?
                    .merge_fetched(&id, models, &api_base)
                    .map_err(app_error)
            })
            .await?;
            follow(&state).await;
            blocking(current).await
        }
        Err(failure) => {
            log::warn!(
                "拉模型提供商 {}（{}）的模型失败：{}",
                found.id,
                found.base_url,
                failure.error
            );
            sophia_core::report::count_error_code(failure.error.code);
            if let Some(reason) = failure.unreachable {
                let detail = failure.error.detail.clone();
                blocking(move || {
                    book()?
                        .record_unreachable(&id, reason, detail)
                        .map_err(app_error)
                })
                .await?;
            }
            Err(failure.error.to_string())
        }
    }
}

/// 启用前试调一次（手动单个启用、手填 id；被限流算能用，同旧网关的试调）。结果说明了密钥时记到那一家上
async fn probe(id: &str, model: &str) -> Result<(), String> {
    let model = model.trim().to_owned();
    if model.is_empty() {
        return Err(app_error(ProviderError::NoModel).to_string());
    }
    let target = id.to_owned();
    let (found, key) = blocking(move || provider(&target)).await?;
    let probe = ProbeTarget {
        api_base: found.upstream_base().to_owned(),
        protocol: if found.protocol() == "responses" {
            Protocol::Responses
        } else {
            Protocol::Chat
        },
        model,
        key,
    };
    let result = runtime::probe_target(&probe).await;
    if let Some(verdict) = runtime::probe_verdict(&result) {
        let id = id.to_owned();
        let rejected = match verdict {
            KeyVerdict::Rejected { detail } => Some(detail),
            KeyVerdict::Accepted => None,
        };
        if let Err(e) =
            blocking(move || book()?.record_key_verdict(&id, rejected).map_err(app_error)).await
        {
            log::warn!("记下试调的密钥结论失败：{e}");
        }
    }
    result.map_err(|e| {
        log::warn!(
            "试调模型提供商 {} 的模型 {} 失败：{e}",
            probe.api_base,
            probe.model
        );
        sophia_core::report::count_error_code(e.code);
        e.to_string()
    })
}

/// 在「启用模型」里勾上 / 取消一个。勾上之前先试调一次，调不通返回 `[代码] 原因`、不启用；
/// 勾上的只进这一家的已启用名单（agent 要用在「选模型」里勾）。取消启用会从各家「已选」里拿掉，开着的跟上
#[tauri::command]
pub async fn providers_set_enabled(
    id: String,
    model: String,
    on: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProviderRow>, String> {
    if on {
        probe(&id, &model).await?;
    }
    let mid = model.trim().to_owned();
    blocking(move || book()?.set_enabled(&id, &mid, on).map_err(app_error)).await?;
    if !on {
        follow(&state).await;
    }
    blocking(current).await
}

/// 手填一个模型 id：先试一下，通了才加进列表并启用（不选进任何 agent）
#[tauri::command]
pub async fn providers_add_typed(id: String, model: String) -> Result<Vec<ProviderRow>, String> {
    probe(&id, &model).await?;
    let mid = model.trim().to_owned();
    blocking(move || book()?.enable_typed(&id, &mid).map_err(app_error)).await?;
    blocking(current).await
}

/// 删掉一家，连同它的密钥（删了回不来，确认由界面负责）。它从各家「已选」里拿掉，开着的跟上
#[tauri::command]
pub async fn providers_remove(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProviderRow>, String> {
    blocking(move || book()?.remove(&id).map(|_| ()).map_err(app_error)).await?;
    follow(&state).await;
    blocking(current).await
}
