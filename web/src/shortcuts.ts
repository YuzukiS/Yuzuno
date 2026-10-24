import { returnSends, type SendKey } from "./device-preferences";

/**
 * The keyboard shortcuts Yuzuno has (T-189), for its help: only those the
 * code binds, where they are bound. Each entry names the handler that
 * implements it. They cannot be changed yet.
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
};
export type ShortcutGroup = { title: string; note?: string; shortcuts: Shortcut[] };

export function shortcutGroups({ modifier, sendKey, touch, desktopApp }: {
  /** ⌘ on Apple devices, Ctrl elsewhere (api.ts). */
  modifier: string;
  sendKey: SendKey;
  /** A touch screen's own keyboard (touch-input.ts). */
  touch: boolean;
  /** The desktop app, not a browser. */
  desktopApp: boolean;
}): ShortcutGroup[] {
  const send = returnSends(sendKey, touch);
  return [
    {
      title: "Anywhere",
      shortcuts: [
        { keys: [modifier, "K"], action: "Find an Agent, or open a message link pasted there (again to close)", source: "App.tsx" },
        { keys: [modifier, "N"], action: "New Agent", source: "App.tsx" },
        { keys: ["Esc"], action: "Interrupt the Agent you are looking at while it works (not while a dialog or menu is open)", source: "App.tsx" },
        ...(desktopApp ? [{ keys: [modifier, ","], action: "Core connection", source: "App.tsx" }] : []),
      ],
    },
    {
      title: "Writing a message",
      note: touch && sendKey === "auto" ? "On this touch screen's keyboard Return makes a new line; Send, or Ctrl or ⌘ with Return from an attached keyboard, sends." : undefined,
      shortcuts: [
        send
          ? { keys: ["Return"], action: "Send", source: "PastedTextComposer.tsx" }
          : { keys: ["Return"], action: "New line", source: "PastedTextComposer.tsx" },
        { keys: [modifier, "Return"], action: "Send", source: "PastedTextComposer.tsx" },
        { keys: ["Shift", "Return"], action: "New line", source: "PastedTextComposer.tsx" },
        { keys: ["/"], action: "At the start of a message: the Agent's commands", source: "slash-commands.ts" },
        { keys: ["$"], action: "At the start of a word, for a Codex Agent: its skills", source: "slash-commands.ts" },
        { keys: ["↑", "↓"], either: true, action: "In the list of commands: move", source: "slash-commands.ts" },
        { keys: ["Return"], action: "In the list of commands: choose (a name typed in full is sent as typed)", source: "slash-commands.ts" },
        { keys: ["Tab"], action: "In the list of commands: choose", source: "slash-commands.ts" },
        { keys: ["Esc"], action: "In the list of commands: close it", source: "slash-commands.ts" },
      ],
    },
    {
      title: "Reading a conversation",
      shortcuts: [
        { keys: [modifier, "F"], action: "Search this conversation", source: "ConversationSearch.tsx" },
        { keys: ["↑", "↓"], either: true, action: "In the Turns dock: move to the previous or next Turn", source: "TurnNavigator.tsx" },
        { keys: ["Home", "End"], either: true, action: "In the Turns dock: move to the first or the latest Turn", source: "TurnNavigator.tsx" },
        { keys: ["Return"], action: "In the Turns dock: go to the Turn moved to", source: "TurnNavigator.tsx", native: true },
      ],
    },
    {
      title: "Home",
      shortcuts: [
        { keys: [modifier, "Return"], action: "Send a reply to a card or an Ask", source: "home/CardReply.tsx, home/AskReply.tsx" },
        { keys: ["Esc"], action: "Close a card's reply", source: "home/CardReply.tsx" },
      ],
    },
    {
      title: "Lists and dialogs",
      shortcuts: [
        { keys: ["↑", "↓"], either: true, action: "Send to Agent: move through the Agents", source: "SendToAgent.tsx" },
        { keys: ["Home", "End"], either: true, action: "Send to Agent: the first or the last Agent", source: "SendToAgent.tsx" },
        { keys: ["Esc"], action: "Close a dialog, menu or card", source: "dialogs and menus", native: true },
        { keys: [modifier, "Z"], action: "Point & Fix: undo the last mark", source: "PointFix.tsx" },
      ],
    },
  ];
}
