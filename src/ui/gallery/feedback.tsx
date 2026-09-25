import { useState } from "react";
import {
  BusySlot,
  Button,
  Confirm,
  HintStrip,
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
      lead="提示框补一句屏幕上没写的；提示条说刚做完了什么、会自己走；灰面板要你处理、不会自己走；新手提示条只在第一次来时说；确认框只问不可逆的决定。"
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
        guide="刚做完的结果，会自己走（成功 4 / 6 秒、做不成 8 秒）｜ 要用户处理的事用灰面板"
      >
        <Specimen label="成功 · 带撤销">
          <Toast
            kind="success"
            verb="写进"
            agents={codex}
            names={["brainstorming"]}
            action={{ label: "撤销", onClick: noop }}
          />
        </Specimen>
        <Specimen label="成功 · 没有动作">
          <Toast kind="success" verb="已添加" reading={<ToastCount n={11} unit="个 skill" />} />
        </Specimen>
        <Specimen label="成功 · 名字 · 读数（trail）">
          <Toast
            kind="success"
            verb="已添加"
            names={["WeiboAP"]}
            trail={["已筛选出它的 7 个 skill"]}
          />
        </Specimen>
        <Specimen label="做不成（错误）">
          <Toast
            kind="cannot"
            verb="没写进"
            agents={codex}
            names={["defuddle"]}
            reason="Codex 的 skills 目录没有写权限"
            stats="~/.codex/skills/defuddle"
            onClose={noop}
          />
        </Specimen>
        <Specimen label="部分失败 · 撤销不可用 + 离开的浅键">
          <Toast
            kind="partial"
            verb="写进"
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
        <Specimen label="撤销在等（忙碌）">
          <Toast
            kind="success"
            verb="写进"
            names={["brainstorming", "defuddle"]}
            action={{ label: "撤销", onClick: noop, busy: "正在撤销" }}
          />
        </Specimen>
        <Specimen label="忙碌形态（结果出来前同一位置）">
          <Toast busy="正在拆开 CardBox 的链接" />
        </Specimen>
      </Block>

      <Block
        name="NoticePanel"
        guide="不会自己走、要你处理的事｜ scope：row 挂在一行下 / section 满这一节 / app 应用级（原 ErrorBanner）｜ 一次性结果用提示条"
      >
        <Specimen label="row · 原因写全 · 可关">
          <NoticePanel
            message="没重启 Codex"
            reason="端口 47328 被别的程序占着"
            action={{ label: "再试一次", onClick: noop }}
            onClose={noop}
          />
        </Specimen>
        <Specimen label="row · 两颗键">
          <NoticePanel
            message="有新版本 0.2.0"
            action={{ label: "安装并重启", onClick: noop }}
            secondary={{ label: "稍后", onClick: noop }}
          />
        </Specimen>
        <Specimen label="row · 忙碌（过门槛）">
          <NoticePanel
            message="Codex 正由 agents-manager 管着"
            busy="正在接管"
            action={{ label: "接管", onClick: noop }}
          />
        </Specimen>
        <Specimen label="row · 键禁用" force="hover">
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

      <Block name="HintStrip" guide="第一次来时说明这里怎么用，只有 ×｜ 报状态、催做事不用它">
        <Specimen label="打开" width={640}>
          <HintStrip open={hint} onDismiss={() => setHint(false)}>
            点格子把 skill 加到那个 agent；● 是已加上，○ 是还没加。不会移动或改动你的文件
          </HintStrip>
          {hint ? null : (
            <Button size="compact" onClick={() => setHint(true)}>
              再出一次
            </Button>
          )}
        </Specimen>
      </Block>

      <Block
        name="Confirm"
        guide="真正不可逆的决定（删原件、删网关、重启 Codex）｜ 能撤销的操作给撤销，不弹确认"
      >
        <Specimen label="居中弹窗 · 遮罩" frame="stage" width={520} height={260}>
          <Confirm title="删掉 openrouter？" confirmLabel="删掉" onConfirm={noop} onCancel={noop}>
            地址和钥匙串里的密钥一起删掉，删除后无法恢复
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
