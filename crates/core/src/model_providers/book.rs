//! 全局模型提供商名单的读写：名单在 settings.json 的 `modelProviders`，密钥在 `secrets.json` 的
//! `providers.global.<id>`。每个改动都在 `Store::lock_settings()` 里读 → 改 → 写，只换 `modelProviders`
//! 这一节，别的设置（两家旧网关、显示名单……）原样不动。无异步、无网络：拉模型、试调由调用方先做完。
//!
//! 密钥与名单的先后（同旧网关）：新加时先存密钥、再存名单，名单没存成就把刚存的密钥删掉；
//! 删除时先存名单、再删密钥——中途失败时留下一个没人用的密钥，好过留下一家没密钥的提供商。
use super::{Added, ModelProviders, NewProvider, Provider, ProviderError};
use crate::codex_models::catalog::Model;
use crate::codex_models::settings::UnreachableReason;
use crate::keystore::{KeyStore, KeyStoreError, GLOBAL};
use crate::store::Store;
use std::path::Path;

/// 名单与密钥的读写入口（数据目录：`Store::default_dir()`；测试指向临时目录）
pub struct Book {
    store: Store,
    keys: KeyStore,
}

fn storage(e: impl std::fmt::Display) -> ProviderError {
    ProviderError::Storage(e.to_string())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Book {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            store: Store::new(data_dir.to_path_buf()),
            keys: KeyStore::new(data_dir),
        }
    }

    /// 现在的名单
    pub fn load(&self) -> Result<ModelProviders, ProviderError> {
        Ok(self.store.load_settings().map_err(storage)?.model_providers)
    }

    /// 这一家的密钥；没有为 `Ok(None)`，读不出（权限、格式坏了）为 `Err`
    pub fn key(&self, id: &str) -> Result<Option<String>, KeyStoreError> {
        self.keys.get(GLOBAL, id)
    }

    /// 在锁里读 → 改 → 写；`change` 返回 Err 时什么都不写
    fn change<T>(
        &self,
        change: impl FnOnce(&mut ModelProviders) -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        let _guard = self.store.lock_settings();
        let mut settings = self.store.load_settings().map_err(storage)?;
        let out = change(&mut settings.model_providers)?;
        self.store.save_settings(&settings).map_err(storage)?;
        Ok(out)
    }

    /// 写密钥前：损坏的密钥文件先另存（同旧网关的界面进程，spec 2026-10-03-keys-in-file R5）
    fn set_key(&self, id: &str, key: &str) -> Result<(), ProviderError> {
        let _ = self.keys.repair_if_corrupt(unix_now());
        self.keys.set(GLOBAL, id, key).map_err(storage)
    }

    /// 加一家：调用方已经用这个密钥拉到了模型列表（`new.fetched`）。名称撞了什么都不写
    pub fn add(&self, new: NewProvider, key: &str) -> Result<Added, ProviderError> {
        crate::keystore::validate_shape(key).map_err(storage)?;
        let _guard = self.store.lock_settings();
        let mut settings = self.store.load_settings().map_err(storage)?;
        let added = settings.model_providers.add(new)?;
        self.set_key(&added.id, key)?;
        if let Err(e) = self.store.save_settings(&settings) {
            let _ = self.keys.delete(GLOBAL, &added.id);
            return Err(storage(e));
        }
        Ok(added)
    }

    /// 改名称、地址；带了新密钥（调用方已用它拉到模型 `fetched`）就一并存密钥、并入模型。
    /// 名称撞了什么都不写（先于存密钥）。返回地址变没变
    pub fn edit(
        &self,
        id: &str,
        name: Option<&str>,
        base_url: &str,
        key: Option<(&str, Vec<Model>, &str)>,
    ) -> Result<bool, ProviderError> {
        let _guard = self.store.lock_settings();
        let mut settings = self.store.load_settings().map_err(storage)?;
        let list = &mut settings.model_providers;
        let changed = list.edit(id, name, base_url)?;
        if let Some((key, fetched, api_base)) = key {
            crate::keystore::validate_shape(key).map_err(storage)?;
            list.merge_fetched(id, fetched, api_base)?;
            list.clear_key_rejection(id)?;
            self.set_key(id, key)?;
        }
        self.store.save_settings(&settings).map_err(storage)?;
        Ok(changed)
    }

    /// 并入重新拉到的模型
    pub fn merge_fetched(
        &self,
        id: &str,
        fetched: Vec<Model>,
        api_base: &str,
    ) -> Result<(), ProviderError> {
        self.change(|list| list.merge_fetched(id, fetched, api_base).map(|_| ()))
    }

    /// 记下拉模型失败的原因
    pub fn record_unreachable(
        &self,
        id: &str,
        reason: UnreachableReason,
        detail: Option<String>,
    ) -> Result<(), ProviderError> {
        self.change(|list| list.record_unreachable(id, reason, detail))
    }

    /// 试调对密钥的结论（`rejected` 为 Some＝被拒，带原文；None＝通了）；状态没变不写文件
    pub fn record_key_verdict(
        &self,
        id: &str,
        rejected: Option<String>,
    ) -> Result<bool, ProviderError> {
        let _guard = self.store.lock_settings();
        let mut settings = self.store.load_settings().map_err(storage)?;
        let changed = settings.model_providers.record_key_verdict(id, rejected);
        if changed {
            self.store.save_settings(&settings).map_err(storage)?;
        }
        Ok(changed)
    }

    /// 用户启用 / 取消启用一个模型（启用前的试调由调用方做）
    pub fn set_enabled(&self, id: &str, model: &str, on: bool) -> Result<(), ProviderError> {
        self.change(|list| list.set_enabled(id, model, on))
    }

    /// 手填一个模型 id 并启用（调用方已经试调通了）
    pub fn enable_typed(&self, id: &str, model: &str) -> Result<(), ProviderError> {
        self.change(|list| list.enable_typed(id, model))
    }

    /// 删掉一家与它的密钥（删了回不来，确认由界面负责）
    pub fn remove(&self, id: &str) -> Result<Provider, ProviderError> {
        let removed = self.change(|list| list.remove(id))?;
        let _ = self.keys.repair_if_corrupt(unix_now());
        self.keys.delete(GLOBAL, id).map_err(|e| {
            ProviderError::Storage(crate::t!("models.providers.keyClearFailed", error = e))
        })?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Settings;
    use crate::test_support::TempTree;
    use serde_json::{json, Value};

    fn new(name: &str, url: &str, fetched: &[&str]) -> NewProvider {
        NewProvider {
            name: name.into(),
            base_url: url.into(),
            protocol: "chat".into(),
            fetched: fetched.iter().map(|id| Model::from(*id)).collect(),
            ..NewProvider::default()
        }
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// 加一家：名单进 settings.json 的 `modelProviders`，密钥按提供商进 `secrets.json` 的 `global`；
    /// 旧版按 agent 存的网关不迁移（#259 起读设置时就不再认它，存一次就不写出了）
    #[test]
    fn adding_stores_the_list_in_settings_and_the_key_per_provider() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let old_codex = json!({"providers": [{"id": "ap", "name": "AP", "baseUrl": "https://ap.example",
                                              "protocol": "chat", "models": []}]});
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec(&json!({"codexGateway": old_codex})).unwrap(),
        )
        .unwrap();
        let book = Book::new(&dir);
        assert!(
            book.load().unwrap().providers.is_empty(),
            "旧文件没有这一节，读成空"
        );

        let added = book
            .add(
                new("Kimi", "https://api.moonshot.cn/v1", &["kimi-k2.6"]),
                "sk-kimi-123456",
            )
            .unwrap();
        assert_eq!(added.id, "kimi");
        assert_eq!(book.key("kimi").unwrap().as_deref(), Some("sk-kimi-123456"));
        let secrets = read(&dir.join("secrets.json"));
        assert_eq!(secrets["providers"]["global"]["kimi"], "sk-kimi-123456");

        let settings = read(&dir.join("settings.json"));
        assert_eq!(settings["modelProviders"]["providers"][0]["name"], "Kimi");
        assert!(settings["codexGateway"].get("providers").is_none());
        assert_eq!(book.load().unwrap().providers.len(), 1);
    }

    /// 同名、密钥形状不对：什么都不写（名单、密钥文件都不变）
    #[test]
    fn a_rejected_add_writes_nothing() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let book = Book::new(&dir);
        book.add(
            new("Kimi", "https://a.example/v1", &["m"]),
            "sk-first-123456",
        )
        .unwrap();
        let before = std::fs::read(dir.join("secrets.json")).unwrap();
        assert_eq!(
            book.add(
                new("KIMI", "https://b.example/v1", &["m"]),
                "sk-second-123456"
            ),
            Err(ProviderError::NameTaken("Kimi".into()))
        );
        assert!(book
            .add(new("Other", "https://b.example/v1", &["m"]), "not a key")
            .is_err());
        assert_eq!(std::fs::read(dir.join("secrets.json")).unwrap(), before);
        assert_eq!(book.load().unwrap().providers.len(), 1);
    }

    /// 改：带新密钥时存密钥、并入模型、清掉「密钥无效」；改名撞了不动密钥
    #[test]
    fn editing_with_a_new_key_replaces_the_key_and_merges_models() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let book = Book::new(&dir);
        book.add(new("A", "https://a.example/v1", &["m1"]), "sk-old-1234567")
            .unwrap();
        book.add(new("B", "https://b.example/v1", &["n1"]), "sk-b-12345678")
            .unwrap();
        book.record_key_verdict("a", Some("401".into())).unwrap();
        assert_eq!(
            book.edit(
                "a",
                Some("b"),
                "https://a.example/v1",
                Some(("sk-new-1234567", vec![], ""))
            ),
            Err(ProviderError::NameTaken("B".into()))
        );
        assert_eq!(book.key("a").unwrap().as_deref(), Some("sk-old-1234567"));

        let changed = book
            .edit(
                "a",
                Some("A2"),
                "https://a2.example/v1",
                Some((
                    "sk-new-1234567",
                    vec![Model::from("m2")],
                    "https://a2.example/v1",
                )),
            )
            .unwrap();
        assert!(changed);
        assert_eq!(book.key("a").unwrap().as_deref(), Some("sk-new-1234567"));
        let list = book.load().unwrap();
        let a = list.provider("a").unwrap();
        assert_eq!(a.name, "A2");
        assert!(a.unreachable.is_none() && !a.key_rejected_on_call);
        // m1 是默认启用的，这次没返回也留着；m2 新出现、不启用
        let ids: Vec<(&str, bool)> = a
            .models
            .iter()
            .map(|m| (m.model.id.as_str(), m.is_enabled()))
            .collect();
        assert_eq!(ids, [("m2", false), ("m1", true)]);
    }

    /// 删：名单里拿掉、密钥一并删掉，别家的密钥不动
    #[test]
    fn removing_deletes_the_provider_and_its_key() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let book = Book::new(&dir);
        book.add(new("A", "https://a.example/v1", &["m"]), "sk-a-12345678")
            .unwrap();
        book.add(new("B", "https://b.example/v1", &["m"]), "sk-b-12345678")
            .unwrap();
        assert_eq!(book.remove("a").unwrap().name, "A");
        assert_eq!(book.key("a").unwrap(), None);
        assert_eq!(book.key("b").unwrap().as_deref(), Some("sk-b-12345678"));
        let list = book.load().unwrap();
        assert_eq!(
            list.providers
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }

    /// 启用、手填、记下连不上：都落盘；整份设置的其余部分照旧
    #[test]
    fn enabling_and_recording_persist_without_touching_other_settings() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let store = Store::new(dir.clone());
        store
            .save_settings(&Settings {
                seen_hints: vec!["first-codex".into()],
                ..Settings::default()
            })
            .unwrap();
        let book = Book::new(&dir);
        book.add(
            new("A", "https://a.example/v1", &["m1", "m2"]),
            "sk-a-12345678",
        )
        .unwrap();
        book.set_enabled("a", "m1", false).unwrap();
        book.enable_typed("a", "typed-x").unwrap();
        book.record_unreachable("a", UnreachableReason::Timeout, None)
            .unwrap();
        let settings = store.load_settings().unwrap();
        assert_eq!(settings.seen_hints, ["first-codex"]);
        let a = settings.model_providers.provider("a").unwrap().clone();
        let enabled: Vec<&str> = a.enabled_models().map(|m| m.model.id.as_str()).collect();
        assert_eq!(enabled, ["m2", "typed-x"]);
        assert_eq!(a.unreachable, Some(UnreachableReason::Timeout));
        assert_eq!(
            book.set_enabled("gone", "m1", true),
            Err(ProviderError::Unknown("gone".into()))
        );
    }
}
