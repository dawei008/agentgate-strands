// 资源库表单抽屉壳（抽屉化批次骨架）：
// 浮层三分法（ADR-0011）：表单=右侧抽屉 / 确认=居中 ConfirmCard / 菜单=浮层。
// 两档宽度：普通表单 600 / 含 JSON 编辑区的宽表单 760。禁止抽屉叠抽屉。
// 职责：
// - 脏状态确认：dirty 时 Esc/mask 关闭先弹「有未保存的修改，确定丢弃？」（danger）
// - 进行中锁：busy 时 Esc/mask 关闭弹「生成中，确定中断？」——确认才关
// - 抽屉头身份行：title（在编辑什么对象）；焦点还原由公共 Drawer 内建
import { useState, type ReactNode } from "react";
import Drawer from "../../components/Drawer";
import ConfirmCard from "../../components/ConfirmCard";
import { Icon } from "../../components/layout/Icons";

export const DRAWER_WIDTH_FORM = 600;
export const DRAWER_WIDTH_WIDE = 760;

export default function FormDrawer({
  open,
  onClose,
  title,
  identity,
  wide = false,
  dirty = false,
  dirtyMessage = "有未保存的修改，确定丢弃？",
  busy = false,
  busyMessage = "生成中，确定中断？",
  testId,
  children,
}: {
  open: boolean;
  /** 真正的关闭（已通过脏/忙确认，或表单自身保存成功后调用） */
  onClose: () => void;
  title: string;
  /** 身份行：在编辑什么对象（数据集名 / 评估器名），无则省略 */
  identity?: ReactNode;
  /** 宽表单（含 JSON 编辑区）用 760，默认 600 */
  wide?: boolean;
  /** 有未保存修改：关闭前弹丢弃确认 */
  dirty?: boolean;
  /** 丢弃确认文案（生成器的「结果」比表单字段更贵，措辞要说清丢了取不回） */
  dirtyMessage?: string;
  /** 进行中锁（AI 生成/红队生成流式中）：关闭前弹中断确认 */
  busy?: boolean;
  busyMessage?: string;
  testId: string;
  /** 函数式 children 拿到 requestClose：表单的「取消」与 Esc/mask 同刑
      （都过脏/忙确认）；保存成功走 onClose 硬关不问脏。 */
  children: ReactNode | ((requestClose: () => void) => ReactNode);
}) {
  const [confirming, setConfirming] = useState<"dirty" | "busy" | null>(null);

  function requestClose() {
    if (busy) { setConfirming("busy"); return; }
    if (dirty) { setConfirming("dirty"); return; }
    onClose();
  }

  function confirmClose() {
    setConfirming(null);
    onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      width={wide ? DRAWER_WIDTH_WIDE : DRAWER_WIDTH_FORM}
      label={title}
      className="res-form-drawer"
      testId={testId}
    >
      <div className="drawer-head">
        <h2>
          {title}
          {identity != null && (
            <span className="res-drawer-identity" data-testid={`${testId}-identity`}>{identity}</span>
          )}
        </h2>
        <button
          type="button"
          className="btn ghost mini"
          onClick={requestClose}
          aria-label={`关闭${title}`}
          data-testid={`${testId}-close`}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="drawer-body">
        {typeof children === "function" ? children(requestClose) : children}
      </div>
      <ConfirmCard
        open={confirming != null}
        title={confirming === "busy" ? "任务进行中" : "未保存的修改"}
        body={confirming === "busy" ? busyMessage : dirtyMessage}
        confirmLabel={confirming === "busy" ? "中断" : "丢弃"}
        danger
        initialFocus="cancel"
        onConfirm={confirmClose}
        onCancel={() => setConfirming(null)}
      />
    </Drawer>
  );
}
