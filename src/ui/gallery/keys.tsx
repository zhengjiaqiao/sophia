import {
  AddButton,
  BusySlot,
  Button,
  IconButton,
  IconEdit,
  IconSettings,
  IconTrash,
} from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const noop = () => {};

/// 键：主键 / 默认键 / 浅键 / 添加键 / 图标键
export function KeysFamily() {
  return (
    <Family
      id="keys"
      title="键"
      lead="会执行动作的字与工具。三档键每档一个意思；忙碌走 BusySlot，禁用必带原因。"
    >
      <Block
        name="Button · default"
        guide="在 Sophia 里做一件事（管理来源、重启生效、再试一次）｜ 单独出现的动作都用它 ｜ 离开 Sophia 用浅键"
      >
        <Specimen label="静止">
          <Button onClick={noop}>管理来源</Button>
        </Specimen>
        <Specimen label="悬停" force="hover">
          <Button onClick={noop}>管理来源</Button>
        </Specimen>
        <Specimen label="按下" force="active">
          <Button onClick={noop}>管理来源</Button>
        </Specimen>
        <Specimen label="键盘焦点" force="focus">
          <Button onClick={noop}>管理来源</Button>
        </Specimen>
        <Specimen label="禁用 · 正在处理上一步">
          <Button disabled disabledReason="正在处理上一步">
            重启生效
          </Button>
        </Specimen>
        <Specimen label="忙碌（过 0.3 秒门槛）">
          <BusySlot busy label="正在检查">
            <Button size="compact">检查更新</Button>
          </BusySlot>
        </Specimen>
        <Specimen label="紧凑 24（表格行、灰面板）">
          <Button size="compact" onClick={noop}>
            再试一次
          </Button>
        </Specimen>
      </Block>

      <Block
        name="Button · primary"
        guide="这一面的主动作，一面至多一个（添加 N 个来源、保存、确认框主动作）"
      >
        <Specimen label="静止">
          <Button variant="primary" size="row" onClick={noop}>
            添加 2 个来源
          </Button>
        </Specimen>
        <Specimen label="悬停" force="hover">
          <Button variant="primary" size="row" onClick={noop}>
            添加 2 个来源
          </Button>
        </Specimen>
        <Specimen label="按下" force="active">
          <Button variant="primary" size="row" onClick={noop}>
            添加 2 个来源
          </Button>
        </Specimen>
        <Specimen label="禁用 · 先勾选要添加的来源">
          <Button variant="primary" size="row" disabled disabledReason="先勾选要添加的来源">
            添加 0 个来源
          </Button>
        </Specimen>
        <Specimen label="紧凑 · 保存">
          <Button variant="primary" size="compact" onClick={noop}>
            保存
          </Button>
        </Specimen>
      </Block>

      <Block
        name="Button · quiet"
        guide="离开 Sophia（打开、在访达中显示、去发布页），末尾自动带 ↗ ｜ 挨着主键的取消不是它"
      >
        <Specimen label="静止">
          <Button variant="quiet" ariaLabel="在访达中显示 ~/.agents/skills/defuddle" onClick={noop}>
            打开
          </Button>
        </Specimen>
        <Specimen label="悬停" force="hover">
          <Button variant="quiet" onClick={noop}>
            打开
          </Button>
        </Specimen>
        <Specimen label="按下" force="active">
          <Button variant="quiet" onClick={noop}>
            打开
          </Button>
        </Specimen>
        <Specimen label="禁用 · 文件夹已经不在了">
          <Button variant="quiet" disabled disabledReason="文件夹已经不在了">
            打开
          </Button>
        </Specimen>
      </Block>

      <Block
        name="AddButton"
        guide="开始一个添加流程，写「+ 名词」（+ 来源、+ 网关）｜ 侧栏的 + 项目 是侧栏行，不是它"
      >
        <Specimen label="静止">
          <AddButton noun="来源" onClick={noop} />
        </Specimen>
        <Specimen label="悬停" force="hover">
          <AddButton noun="网关" onClick={noop} />
        </Specimen>
        <Specimen label="按下" force="active">
          <AddButton noun="网关" onClick={noop} />
        </Specimen>
        <Specimen label="禁用 · 先保存正在编辑的网关">
          <AddButton noun="网关" disabledReason="先保存正在编辑的网关" />
        </Specimen>
      </Block>

      <Block
        name="IconButton"
        guide="词表里有图形的工具（编辑、删掉、关掉、返回、设置）｜ 词表外的动作写字"
      >
        <Specimen label="静止 · 编辑">
          <IconButton icon={<IconEdit />} title="编辑" onClick={noop} />
        </Specimen>
        <Specimen label="悬停 · 删掉 openrouter" force="hover">
          <IconButton icon={<IconTrash />} title="删掉 openrouter" onClick={noop} />
        </Specimen>
        <Specimen label="键盘焦点 · 设置" force="focus">
          <IconButton icon={<IconSettings />} title="设置" onClick={noop} />
        </Specimen>
        <Specimen label="禁用 · 最后一家还在供模型">
          <IconButton
            icon={<IconTrash />}
            title="删掉 openrouter"
            disabledReason="这是最后一家还在供模型的网关，先关掉第三方模型"
          />
        </Specimen>
      </Block>
    </Family>
  );
}
