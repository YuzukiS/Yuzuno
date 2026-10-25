import { useState } from "react";
import { Modal } from "./components";
import { langTag, strings, useLanguage } from "./i18n";

const text = strings({
  reset: "Reset saved draft…",
  title: "Discard this saved draft?",
  description: "Some or all of this draft could not be read. This permanently discards this Agent’s saved draft, including any readable text. Copy text from another open window first. Conversation messages are not affected.",
  failed: "The draft could not be reset. It has not been discarded. Check browser storage access and try again.",
  cancel: "Cancel",
  discard: "Discard saved draft",
  closeDialog: "Close dialog",
}, {
  reset: "重置已保存的草稿…",
  title: "要丢弃这份已保存的草稿吗？",
  description: "这份草稿的部分或全部内容无法读取。这会永久丢弃此 Agent 已保存的草稿，包括其中可读的文本。请先从另一个打开的窗口复制文本。会话消息不受影响。",
  failed: "无法重置草稿，草稿未被丢弃。请检查浏览器存储权限后重试。",
  cancel: "取消",
  discard: "丢弃已保存的草稿",
  closeDialog: "关闭对话框",
});

export function DraftRecovery({ onDiscard }: { onDiscard: () => boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const language = useLanguage();
  const t = text(language);
  return (
    <>
      <button
        type="button"
        className="quiet-button"
        onClick={() => {
          setFailed(false);
          setOpen(true);
        }}
      >
        {t.reset}
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t.title}
        description={t.description}
        lang={langTag(language)}
        closeLabel={t.closeDialog}
      >
        {failed && (
          <p className="inline-error" role="alert">
            {t.failed}
          </p>
        )}
        <div className="pasted-text-dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setOpen(false)}
          >
            {t.cancel}
          </button>
          <button
            type="button"
            className="quiet-button danger"
            onClick={() => {
              if (onDiscard()) setOpen(false);
              else setFailed(true);
            }}
          >
            {t.discard}
          </button>
        </div>
      </Modal>
    </>
  );
}
