import { useState } from "react";
import { canRestore, parseBackendError } from "../modelsView";
import type { GatewayState } from "../types";
import { Busy, Button, ErrorBanner, SubPage } from "../ui";
import "./GatewayPage.css";

/// Codex 网关的配置页（spec R5、组件规范 §4.6）：占满整窗的二级页面，不渲染侧栏。
///
/// 只装四样东西：网关地址、API 密钥、`保存` + `拉取模型`、以及两条只读事实
/// （本机路由与协议）。**返回即保存**——地址或密钥改过还没保存时，点 `←` / Esc
/// 会先保存再走；保存没成功就留在这一页，把网关的原话摆出来，不把用户的输入丢掉。
///
/// 三件故意不做的事：
/// - **端口与协议只读**。它们是正确性配置不是口味选项，改错了整条链路不通，
///   而用户没有判断依据（spec 设计一节）。
/// - 密钥从不回显，输入框空着就是「不改」。
/// - 停用不在这一页——行上那个开关就是它的入口。这里只留「已经停用了、
///   但后台服务还装着」那一种收尾。

export interface GatewayPageProps {
  state: GatewayState;
  busy: boolean;
  onBack: () => void;
  /// 保存网关地址与密钥（密钥为空表示不改）。失败时抛出，由本页就地说明
  onSaveProvider: (baseUrl: string, key: string) => Promise<void>;
  onFetchModels: () => Promise<void>;
  /// 彻底撤下：卸载后台服务，清掉本功能写进 Codex 设置的一切
  onRestore: () => Promise<void>;
}

export function GatewayPage({
  state,
  busy,
  onBack,
  onSaveProvider,
  onFetchModels,
  onRestore,
}: GatewayPageProps) {
  const [baseUrl, setBaseUrl] = useState(state.provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  /// 这一页自己的应用级故障位：保存 / 拉取 / 撤下 的原话都摆在这儿，不自动消失（§4.2）
  const [error, setError] = useState<string | null>(null);

  const dirty = baseUrl.trim() !== state.provider.baseUrl || apiKey !== "";

  /// 失败时把后端的原话留在页面上，成功时清掉
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      setError(null);
      return true;
    } catch (e) {
      setError(parseBackendError(String(e)).message);
      return false;
    }
  };

  const save = async (): Promise<boolean> => {
    const ok = await run(() => onSaveProvider(baseUrl, apiKey));
    // 密钥保存成功就不再留在输入框里；失败时原样保留，用户可以改了再试
    if (ok) setApiKey("");
    return ok;
  };

  /// 返回即保存：有没保存的改动就先存，存不下就留在这一页
  const back = async () => {
    if (dirty && baseUrl.trim() !== "" && !(await save())) return;
    onBack();
  };

  return (
    <SubPage title="Codex 网关" onBack={() => void back()}>
      {error !== null ? <ErrorBanner message={error} onClose={() => setError(null)} /> : null}
      <Busy busy={busy} className="gateway-page">
        <label className="gateway-page__field">
          <span className="gateway-page__label">网关地址</span>
          <input
            className="gateway-page__input gateway-page__input--mono"
            type="text"
            value={baseUrl}
            placeholder="https://example.com/openai/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <label className="gateway-page__field">
          <span className="gateway-page__label">API 密钥</span>
          <input
            className="gateway-page__input"
            type="password"
            value={apiKey}
            autoComplete="off"
            placeholder={state.provider.hasKey ? "已保存，留空则不修改" : "输入密钥"}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        {/* 两个动作只有一个是 pill，另一个降为文字链（§6） */}
        <div className="gateway-page__actions">
          {baseUrl.trim() === "" ? (
            <Button disabled disabledReason="先填上网关地址">
              保存
            </Button>
          ) : (
            <Button onClick={() => void save()}>保存</Button>
          )}
          {state.provider.hasKey ? (
            <Button variant="link" onClick={() => void run(onFetchModels)}>
              拉取模型
            </Button>
          ) : (
            <Button variant="link" disabled disabledReason="先保存密钥，才能去网关取模型列表">
              拉取模型
            </Button>
          )}
        </div>

        {/* 只读事实：端口与协议不做成可改（spec 设计一节） */}
        <div className="gateway-page__facts">
          本机路由 <span className="gateway-page__mono">127.0.0.1:{state.router.port}</span> · 协议{" "}
          <span className="gateway-page__mono">{state.router.protocol || "chat"}</span>
        </div>
        <div className="gateway-page__note">
          端口和协议是接得通接不通的事，不是口味选项，所以这里只摆出来不给改。
        </div>

        {/* 边界态：已经停用了，但后台服务还装着 */}
        {!state.enabled && canRestore(state) ? (
          <div className="gateway-page__leftover">
            <span className="gateway-page__leftover-text">
              后台服务还装着。它只是空转，也可以现在就撤掉。
            </span>
            <Button size="compact" onClick={() => void run(onRestore)}>
              彻底撤下
            </Button>
          </div>
        ) : null}
      </Busy>
    </SubPage>
  );
}

export default GatewayPage;
