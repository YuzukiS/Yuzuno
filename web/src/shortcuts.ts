import { returnSends, type SendKey } from "./device-preferences";
import { strings, type Language } from "./i18n";
import { defaultShortcutKeys, type Rebindable, type ShortcutKeys } from "./shortcut-keys";

/**
 * The keyboard shortcuts Yuzuno has (T-189), for its help: only those the
 * code binds, where they are bound. Each entry names the handler that
 * implements it. Three take another letter on this device (shortcut-keys.ts).
 */
export type Shortcut = {
  /** Keys pressed together, each shown as its own key; with `either`, keys
   * that each do it (↑ or ↓). */
  keys: string[];
  either?: boolean;
  /** Done by the browser for the control (a button pressed with Return, a
   * dialog closed with Esc), not by a key handler of Yuzuno's own. */
  native?: boolean;
  action: string;
  /** Where it is handled, for whoever changes it. */
  source: string;
  /** One this device may give another letter: its key here is the one in effect. */
  rebind?: Rebindable;
};
export type ShortcutGroup = { title: string; note?: string; shortcuts: Shortcut[] };

// What each shortcut does, in the interface language (T-189). Key names and
// the handlers' files are written as they are.
const text = strings({
  anywhere: "Anywhere",
  find: "Find an Agent, or open a message link pasted there (again to close)",
  newAgent: "New Agent",
  interrupt: "Interrupt the Agent you are looking at while it works (not while a dialog or menu is open)",
  connection: "Core connection",
  writing: "Writing a message",
  touchNote: "On this touch screen's keyboard Return makes a new line; Send, or Ctrl or ⌘ with Return from an attached keyboard, sends.",
  send: "Send",
  newLine: "New line",
  commands: "At the start of a message: the Agent's commands",
  skills: "At the start of a word, for a Codex Agent: its skills",
  commandsMove: "In the list of commands: move",
  commandsChooseTyped: "In the list of commands: choose (a name typed in full is sent as typed)",
  commandsChoose: "In the list of commands: choose",
  commandsClose: "In the list of commands: close it",
  reading: "Reading a conversation",
  search: "Search this conversation",
  turnsMove: "In the Turns dock: move to the previous or next Turn",
  turnsEnds: "In the Turns dock: move to the first or the latest Turn",
  turnsGo: "In the Turns dock: go to the Turn moved to",
  home: "Home",
  reply: "Send a reply to a card or an Ask",
  closeReply: "Close a card's reply",
  lists: "Lists and dialogs",
  agentsMove: "Send to Agent: move through the Agents",
  agentsEnds: "Send to Agent: the first or the last Agent",
  categoriesMove: "Settings: the next or the previous category",
  categoriesEnds: "Settings: the first or the last category",
  close: "Close a dialog, menu or card",
  undoMark: "Point & Fix: undo the last mark",
}, {
  anywhere: "任何地方",
  find: "查找 Agent，或打开粘贴在那里的消息链接（再按一次关闭）",
  newAgent: "新建 Agent",
  interrupt: "在你正在看的 Agent 工作时中断它（对话框或菜单打开时除外）",
  connection: "Core 连接",
  writing: "撰写消息",
  touchNote: "在此触摸屏的键盘上，Return 换行；点“发送”，或在外接键盘上按 Ctrl 或 ⌘ 加 Return，即可发送。",
  send: "发送",
  newLine: "换行",
  commands: "在消息开头：Agent 的命令",
  skills: "在词的开头，对 Codex Agent：它的技能",
  commandsMove: "在命令列表中：移动",
  commandsChooseTyped: "在命令列表中：选择（完整输入的名称按输入原样发送）",
  commandsChoose: "在命令列表中：选择",
  commandsClose: "在命令列表中：关闭它",
  reading: "阅读会话",
  search: "搜索此会话",
  turnsMove: "在 Turns 栏中：移到上一个或下一个 Turn",
  turnsEnds: "在 Turns 栏中：移到第一个或最新的 Turn",
  turnsGo: "在 Turns 栏中：前往移到的 Turn",
  home: "Home",
  reply: "向卡片或 Ask 发送回复",
  closeReply: "关闭卡片的回复",
  lists: "列表与对话框",
  agentsMove: "发送给 Agent：在 Agent 之间移动",
  agentsEnds: "发送给 Agent：第一个或最后一个 Agent",
  categoriesMove: "设置：下一个或上一个类别",
  categoriesEnds: "设置：第一个或最后一个类别",
  close: "关闭对话框、菜单或卡片",
  undoMark: "Point & Fix：撤销上一个标记",
});

export function shortcutGroups({ modifier, sendKey, touch, desktopApp, keys = defaultShortcutKeys, language = "en" }: {
  /** ⌘ on Apple devices, Ctrl elsewhere (api.ts). */
  modifier: string;
  sendKey: SendKey;
  /** A touch screen's own keyboard (touch-input.ts). */
  touch: boolean;
  /** The desktop app, not a browser. */
  desktopApp: boolean;
  /** This device's letters for the three it may change. */
  keys?: ShortcutKeys;
  language?: Language;
}): ShortcutGroup[] {
  const send = returnSends(sendKey, touch);
  const t = text(language);
  return [
    {
      title: t.anywhere,
      shortcuts: [
        { keys: [modifier, keys.find], action: t.find, source: "App.tsx", rebind: "find" },
        { keys: [modifier, keys.newAgent], action: t.newAgent, source: "App.tsx", rebind: "newAgent" },
        { keys: ["Esc"], action: t.interrupt, source: "App.tsx" },
        ...(desktopApp ? [{ keys: [modifier, ","], action: t.connection, source: "App.tsx" }] : []),
      ],
    },
    {
      title: t.writing,
      note: touch && sendKey === "auto" ? t.touchNote : undefined,
      shortcuts: [
        send
          ? { keys: ["Return"], action: t.send, source: "PastedTextComposer.tsx" }
          : { keys: ["Return"], action: t.newLine, source: "PastedTextComposer.tsx" },
        { keys: [modifier, "Return"], action: t.send, source: "PastedTextComposer.tsx" },
        { keys: ["Shift", "Return"], action: t.newLine, source: "PastedTextComposer.tsx" },
        { keys: ["/"], action: t.commands, source: "slash-commands.ts" },
        { keys: ["$"], action: t.skills, source: "slash-commands.ts" },
        { keys: ["↑", "↓"], either: true, action: t.commandsMove, source: "slash-commands.ts" },
        { keys: ["Return"], action: t.commandsChooseTyped, source: "slash-commands.ts" },
        { keys: ["Tab"], action: t.commandsChoose, source: "slash-commands.ts" },
        { keys: ["Esc"], action: t.commandsClose, source: "slash-commands.ts" },
      ],
    },
    {
      title: t.reading,
      shortcuts: [
        { keys: [modifier, keys.search], action: t.search, source: "ConversationSearch.tsx", rebind: "search" },
        { keys: ["↑", "↓"], either: true, action: t.turnsMove, source: "TurnNavigator.tsx" },
        { keys: ["Home", "End"], either: true, action: t.turnsEnds, source: "TurnNavigator.tsx" },
        { keys: ["Return"], action: t.turnsGo, source: "TurnNavigator.tsx", native: true },
      ],
    },
    {
      title: t.home,
      shortcuts: [
        { keys: [modifier, "Return"], action: t.reply, source: "home/CardReply.tsx, home/AskReply.tsx" },
        { keys: ["Esc"], action: t.closeReply, source: "home/CardReply.tsx" },
      ],
    },
    {
      title: t.lists,
      shortcuts: [
        { keys: ["↑", "↓"], either: true, action: t.agentsMove, source: "SendToAgent.tsx" },
        { keys: ["Home", "End"], either: true, action: t.agentsEnds, source: "SendToAgent.tsx" },
        { keys: ["↑", "↓", "←", "→"], either: true, action: t.categoriesMove, source: "SettingsCenter.tsx" },
        { keys: ["Home", "End"], either: true, action: t.categoriesEnds, source: "SettingsCenter.tsx" },
        { keys: ["Esc"], action: t.close, source: "dialogs and menus", native: true },
        { keys: [modifier, "Z"], action: t.undoMark, source: "PointFix.tsx" },
      ],
    },
  ];
}
