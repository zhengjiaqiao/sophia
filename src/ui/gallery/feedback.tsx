import { useState } from "react";
import {
  BusySlot,
  Button,
  Confirm,
  CornerToast,
  Details,
  FaultView,
  NoticePanel,
  Spinner,
  StateDot,
  StateDotButton,
  Toast,
  ToastCount,
  Tooltip,
} from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const noop = () => {};
const codex = [{ id: "codex", name: "Codex" }];

/// 提示与反馈：按「谁开口 × 会不会自己走」分五种，一件事只在一处说
export function FeedbackFamily() {
  const [hint, setHint] = useState(true);
  return (
    <Family
      id="feedback"
      title="提示与反馈"
      lead="提示框补一句屏幕上没写的；提示条说刚做完了什么、会自己走（锚点轻量一行，右下带记号栏）；灰面板嵌在页面里、不会自己走（左 ! 要你处理，没有 ! 是一次性说明）；确认框只问不可逆的决定。"
    >
      <Block
        name="Tooltip"
        guide="悬停补一句屏幕上没写的（禁用原因、截断全文、格子动作）｜ 已经写在屏幕上的话不要再说"
      >
        <Specimen label="表格外 · 默认键上的说明" width={280} height={96}>
          <div className="gallery-tipstage">
            <Tooltip
              content="重启 Codex 桌面应用让改动生效，进行中的对话会中断"
              placement="bottom"
              open
            >
              <Button size="compact" onClick={noop}>
                重启生效
              </Button>
            </Tooltip>
          </div>
        </Specimen>
        <Specimen label="表格格子（受控、700ms、键盘才写快捷键）" width={280} height={96}>
          <div className="gallery-tipstage">
            <Tooltip
              content={
                <>
                  <b>点一下</b>加到 Codex
                </>
              }
              shortcut="空格"
              context="table"
              placement="bottom"
              open
              ceiling
            >
              <StateDotButton aria-label="brainstorming · Codex：未加上">
                <StateDot dot="missing" hoverable title="" />
              </StateDotButton>
            </Tooltip>
          </div>
        </Specimen>
        <Specimen label="禁用原因（按下当即出）" width={200} height={96}>
          <div className="gallery-tipstage">
            <Tooltip content="先填地址" placement="bottom" focusable explain open>
              <Button variant="primary" size="compact" disabled disabledReason="先填地址">
                保存
              </Button>
            </Tooltip>
          </div>
        </Specimen>
      </Block>

      <Block
        name="Toast"
        guide="刚做完的结果，会自己走（成功 3 / 6 秒、做不成 8 秒）；长相由出在哪定：锚在触发处一律轻量一行，右下一律带记号栏｜ 要用户处理的事用灰面板"
      >
        <Specimen label="锚点 · 成功 · 带撤销">
          <Toast
            kind="success"
            sentence="toast.line.success.write"
            agents={codex}
            names={["brainstorming"]}
            action={{ label: "撤销", onClick: noop }}
          />
        </Specimen>
        <Specimen label="锚点 · 成功 · 名字 · 读数（trail）">
          <Toast
            kind="success"
            sentence="sources.added.done"
            names={["WeiboAP"]}
            trail={["已筛选出它的 7 个 skill"]}
          />
        </Specimen>
        <Specimen label="锚点 · 做不成 · 原因 + ×">
          <Toast
            kind="cannot"
            sentence="toast.line.cannot.write"
            agents={codex}
            names={["defuddle"]}
            reason="已有同名"
            onClose={noop}
          />
        </Specimen>
        <Specimen label="锚点 · 做不成 · 第二行路径（与字对齐）">
          <Toast
            kind="cannot"
            sentence="toast.line.cannot.write"
            agents={codex}
            names={["defuddle"]}
            reason="Codex 的 skills 目录没有写权限"
            stats="~/.codex/skills/defuddle"
            onClose={noop}
          />
        </Specimen>
        <Specimen label="锚点 · 部分失败 · 原因放不下（折两行，与字对齐）">
          <Toast
            kind="partial"
            sentence="toast.line.partial.write"
            tally={{ done: 2, failed: 1 }}
            reason="Cline 的 skills 目录是一个指向外置磁盘的链接，磁盘此刻没有接上"
            action={{ label: "撤销", onClick: noop }}
            onClose={noop}
          />
        </Specimen>
        <Specimen label="锚点 · 单格失败（整句）">
          <Toast kind="cannot" message="无法写入 Codex 的 skills 目录" />
        </Specimen>
        <Specimen label="锚点 · 部分失败 · 撤销不可用 + 离开的浅键">
          <Toast
            kind="partial"
            sentence="toast.line.partial.write"
            tally={{ done: 2, failed: 1 }}
            action={{
              label: "撤销",
              onClick: noop,
              disabledReason: "写入之后文件又被改过，无法安全撤销",
            }}
            secondary={{ label: "在访达中显示备份", onClick: noop }}
            onClose={noop}
          />
        </Specimen>
        <Specimen label="锚点 · 撤销在等（忙碌）">
          <Toast
            kind="success"
            sentence="toast.line.success.write"
            names={["brainstorming", "defuddle"]}
            action={{ label: "撤销", onClick: noop, busy: "正在撤销" }}
          />
        </Specimen>
        <Specimen label="锚点 · 忙碌形态（结果出来前同一位置）">
          <Toast busy="正在拆开 CardBox 的链接" />
        </Specimen>
        <Specimen label="右下 · 成功（后台自动添加）">
          <CornerToast>
            <Toast
              kind="success"
              sentence="shell.mcpToast.autoAdd"
              names={["brave-search"]}
              onClose={noop}
            />
          </CornerToast>
        </Specimen>
        <Specimen label="右下 · 成功 · 没有名字（读数）">
          <CornerToast>
            <Toast
              kind="success"
              sentence="sources.added.done"
              reading={<ToastCount n={11} line="market.update.count" />}
            />
          </CornerToast>
        </Specimen>
        <Specimen label="右下 · 成功 · 读数很长（在框里折行）">
          <CornerToast>
            <Toast
              kind="success"
              sentence="sources.added.done"
              names={["brave-search"]}
              trail={["只在 weibo-ai-platform-recommendation-service-monorepo 里能用了"]}
            />
          </CornerToast>
        </Specimen>
        <Specimen label="锚点 · 成功 · 读数很长（折两行）">
          <Toast
            kind="success"
            sentence="sources.added.done"
            names={["brave-search"]}
            trail={["只在 weibo-ai-platform-recommendation-service-monorepo 里能用了"]}
            action={{ label: "撤销", onClick: noop }}
          />
        </Specimen>
        <Specimen label="右下 · 部分失败">
          <CornerToast>
            <Toast
              kind="partial"
              sentence="shell.mcpToast.autoAdd"
              names={["brave-search"]}
              tally={{ done: 1, failed: 1 }}
              reason="Cline 的配置文件不是合法的 JSON"
              onClose={noop}
            />
          </CornerToast>
        </Specimen>
      </Block>

      <Block
        name="NoticePanel"
        guide="嵌在页面里、不会自己走的一句｜ 左 ! ＝有问题要你处理，没有 ! ＝一次性说明；右 × ＝能关｜ scope：row 挂在一行下 / section 满这一节 / app 应用级｜ 一次性结果用提示条"
      >
        <Specimen label="! · 不可关 · 一颗键（待办）">
          <NoticePanel
            message="Sophia 写进去的设置被改掉了"
            action={{ label: "重新写入", onClick: noop }}
          />
        </Specimen>
        <Specimen label="! · 原因写全 · 可关">
          <NoticePanel
            message="没重启 Codex"
            reason="端口 47328 被别的程序占着"
            action={{ label: "再试一次", onClick: noop }}
            onClose={noop}
          />
        </Specimen>
        <Specimen label="! · 两颗键">
          <NoticePanel
            message="有新版本 0.2.0"
            action={{ label: "安装并重启", onClick: noop }}
            secondary={{ label: "稍后", onClick: noop }}
          />
        </Specimen>
        <Specimen label="! · 忙碌（过门槛）">
          <NoticePanel
            message="Codex 正由 agents-manager 管着"
            busy="正在接管"
            action={{ label: "接管", onClick: noop }}
          />
        </Specimen>
        <Specimen label="! · 键禁用" force="hover">
          <NoticePanel
            message="Sophia 写进去的设置被改掉了"
            action={{ label: "重新写入", onClick: noop, disabledReason: "正在处理上一步" }}
          />
        </Specimen>
        <Specimen label="section · 满这一节的宽" width={640}>
          <NoticePanel
            scope="section"
            message="路由没在跑"
            reason="上次退出时没收干净"
            action={{ label: "重启路由", onClick: noop }}
          />
        </Specimen>
        <Specimen label="没有 ! · × · 一次性说明（进出）" width={640}>
          <NoticePanel
            scope="section"
            mark={false}
            open={hint}
            onClose={() => setHint(false)}
            message="点格子把 skill 加到那个 agent；● 是已加上，○ 是还没加。不会移动或改动你的文件"
          />
          {hint ? null : (
            <Button size="compact" onClick={() => setHint(true)}>
              再出一次
            </Button>
          )}
        </Specimen>
        <Specimen label="没有 ! · 两颗键 + ×（有新版本）" width={640}>
          <NoticePanel
            scope="section"
            mark={false}
            message="2 个 skill 有新版本"
            action={{ label: "只看这些", onClick: noop }}
            secondary={{ label: "全部更新", onClick: noop }}
            onClose={noop}
            dismissTitle="这一批不再提示"
          />
        </Specimen>
        <Specimen label="没有 ! · 叠放（下面还压着一张）" width={640}>
          <NoticePanel
            scope="section"
            mark={false}
            open
            stacked={1}
            message="读了 Claude Code、Codex 的 skill 目录，找到 31 个 skill，没有改动任何文件。"
            onClose={noop}
          />
        </Specimen>
        <Specimen label="! · 出错带详情：详情 + 往前走的路（键在主键之前）" width={640}>
          <NoticePanel
            scope="section"
            message="读不到第三方模型的状态"
            reason="~/.codex/config.toml 不归你的账户所有，读不了（多半是用 sudo 运行过 Codex）"
            technical={"open ~/.codex/config.toml\nPermission denied (os error 13)"}
            onCopy={noop}
            action={{ label: "修复权限", onClick: noop }}
          />
        </Specimen>
        <Specimen label="! · 详情 + 离开 Sophia 的浅键 + 再试一次" width={640}>
          <NoticePanel
            scope="section"
            message="读不到第三方模型的状态"
            reason="~/.codex/config.toml 第 3 行格式有误"
            technical={"/Users/…/.codex/config.toml\nTOML parse error at line 3, column 8"}
            onCopy={noop}
            action={{ label: "打开文件", leave: true, onClick: noop }}
            secondary={{ label: "再试一次", onClick: noop }}
          />
        </Specimen>
        <Specimen label="app · 应用级故障（错误）" width={640}>
          <NoticePanel
            scope="app"
            message="读不到 skill 目录"
            detail="~/.agents/skills 没有读权限"
            action={{ label: "再试一次", onClick: noop }}
            onClose={noop}
          />
        </Specimen>
      </Block>

      <Block
        name="Details"
        guide="出错提示上的技术原文（请求、状态码、返回的错误、调用栈）｜ 一颗默认键 `详情`，点开是锚在键上的浮层：原文 + `复制详情`，点外面 / Esc 关｜ 长条提示里不展开；提示条里不放"
      >
        <Specimen label="收起：一颗紧凑默认键">
          <Details text="GET https://openrouter.ai/api/v1/models → 429" onCopy={noop} />
        </Specimen>
        <Specimen
          label="点开：锚在键上的浮层（点外面、Esc 关）"
          frame="stage"
          width={520}
          height={220}
        >
          <Details
            defaultOpen
            align="start"
            onCopy={noop}
            text={
              'GET https://openrouter.ai/api/v1/models → 429 Too Many Requests · Retry-After: 30\n{"error":{"message":"Rate limit exceeded: free-models-per-min"}}'
            }
          />
        </Specimen>
        <Specimen
          label="出错页（PageFault）：重新加载 + 详情同一行"
          frame="stage"
          width={520}
          height={240}
        >
          <FaultView
            details={
              "TypeError: x is not a function\n    at ModelsPage (ModelsPage.tsx:12:3)\n\nversion: 0.2.0"
            }
            onReload={noop}
            onCopy={noop}
          />
        </Specimen>
      </Block>

      <Block
        name="Confirm"
        guide="真正不可逆的决定（删原件、删网关、重启 Codex）｜ 能撤销的操作给撤销，不弹确认"
      >
        <Specimen label="居中弹窗 · 遮罩" frame="stage" width={520} height={260}>
          <Confirm title="删掉 openrouter？" confirmLabel="删掉" onConfirm={noop} onCancel={noop}>
            地址和密钥一起删掉，删除后无法恢复
          </Confirm>
        </Specimen>
        <Specimen label="路径铭牌 · 主动作禁用" frame="stage" width={520} height={300}>
          <Confirm
            title="删掉 defuddle 的原件？"
            nameplate={{ path: "~/.agents/skills/defuddle", meta: "3 个文件 · 24 KB" }}
            confirmLabel="删到废纸篓"
            confirmDisabledReason="原件在 git 仓库里，请在仓库里删掉并提交"
            onCancel={noop}
          />
        </Specimen>
        <Specimen label="窄面板形态（托盘里就地展开）" width={296}>
          <Confirm
            inline
            id="gallery-tray-confirm"
            title="重启 Codex？"
            confirmLabel="重启"
            onConfirm={noop}
            onCancel={noop}
          >
            进行中的对话会中断
          </Confirm>
        </Specimen>
      </Block>

      <Block
        name="BusySlot · Spinner"
        guide="用户发起、正在等的那颗键原位忙碌，0.3 秒门槛｜ 后台例行读取不显示忙碌"
      >
        <Specimen label="replace · 原位换成刻度 + 一句">
          <BusySlot busy label="正在重启 Codex">
            <Button size="compact">重启生效</Button>
          </BusySlot>
        </Specimen>
        <Specimen label="dim · 变淡（选择行的一点）">
          <BusySlot busy mode="dim" label="正在加到 Codex">
            <StateDotButton aria-label="选中的都加到 Codex">
              <StateDot dot="linked" title="" />
            </StateDotButton>
          </BusySlot>
        </Specimen>
        <Specimen label="float · 一句话浮在键下" frame="stage" width={260} height={120}>
          <div className="gallery-tipstage">
            <BusySlot busy mode="float" label="正在拆开">
              <StateDotButton aria-label="ego-browser · Codex：整个文件夹是链接">
                <StateDot dot="wholeLinked" title="" />
              </StateDotButton>
            </BusySlot>
          </div>
        </Specimen>
        <Specimen label="Spinner 14 · 24">
          <span className="gallery-row">
            <Spinner size={14} label="正在读来源" />
            <Spinner size={24} label="正在读 skill 目录" />
          </span>
        </Specimen>
      </Block>
    </Family>
  );
}
