// Builds the iPhone/Mac Shortcuts ("Alfred" and "Type to Alfred") as plist data, so nobody has to
// assemble them by hand. Setup writes them out, signs them with macOS's `shortcuts sign` and opens
// them for one-click import; iCloud then puts them on the iPhone.
//
// The encodings follow real exports from iOS 26 Shortcuts and were cross-checked against the Cherri
// compiler (github.com/electrikmilk/cherri) and Raycast's Focus helper.
import { randomUUID } from "node:crypto";

type Obj = Record<string, unknown>;
type Ref = Obj; // what an attachment points at: an action's output, a named variable, Shortcut Input...

interface Action {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: Obj;
}

const OBJ = "￼"; // the placeholder character a variable occupies inside a text field

// Built-in actions are "is.workflow.actions.<name>"; app intents (com.apple...) are used as given.
const act = (id: string, params: Obj = {}): Action => ({
  WFWorkflowActionIdentifier: id.startsWith("com.") ? id : `is.workflow.actions.${id}`,
  WFWorkflowActionParameters: params,
});

const output = (uuid: string, name: string): Ref => ({ Type: "ActionOutput", OutputUUID: uuid, OutputName: name });
const variable = (name: string): Ref => ({ Type: "Variable", VariableName: name });
const shortcutInput: Ref = { Type: "ExtensionInput" };
const currentDate: Ref = { Type: "CurrentDate" };

// A value passed as-is (WFInput and similar).
const attachment = (ref: Ref) => ({ Value: ref, WFSerializationType: "WFTextTokenAttachment" });

// A text field: plain text, or one variable as the whole text.
const text = (value: string | Ref) =>
  typeof value === "string"
    ? { Value: { string: value }, WFSerializationType: "WFTextTokenString" }
    : { Value: { string: OBJ, attachmentsByRange: { "{0, 1}": value } }, WFSerializationType: "WFTextTokenString" };

// Header and JSON body fields (all text).
const fields = (entries: [string, string | Ref][]) => ({
  Value: { WFDictionaryFieldValueItems: entries.map(([k, v]) => ({ WFItemType: 0, WFKey: text(k), WFValue: text(v) })) },
  WFSerializationType: "WFDictionaryFieldValue",
});

const CONDITION = { is: 4, contains: 99, hasAnyValue: 100 } as const;

// If <input> <condition> [<value>] { then } else { otherwise }
function ifBlock(input: Ref, condition: keyof typeof CONDITION, value: string | null, then: Action[], otherwise?: Action[]): Action[] {
  const group = randomUUID().toUpperCase();
  const start: Obj = {
    GroupingIdentifier: group,
    WFControlFlowMode: 0,
    WFCondition: CONDITION[condition],
    WFInput: { Type: "Variable", Variable: attachment(input) },
  };
  if (value !== null) start.WFConditionalActionString = value;
  return [
    act("conditional", start),
    ...then,
    ...(otherwise ? [act("conditional", { GroupingIdentifier: group, WFControlFlowMode: 1 }), ...otherwise] : []),
    act("conditional", { GroupingIdentifier: group, WFControlFlowMode: 2, UUID: randomUUID().toUpperCase() }),
  ];
}

function repeatEach(input: Ref, body: Action[]): Action[] {
  const group = randomUUID().toUpperCase();
  return [
    act("repeat.each", { GroupingIdentifier: group, WFControlFlowMode: 0, WFInput: attachment(input) }),
    ...body,
    act("repeat.each", { GroupingIdentifier: group, WFControlFlowMode: 2, UUID: randomUUID().toUpperCase() }),
  ];
}

// An action whose output is used later: the action, and a reference to its output.
function producing(id: string, name: string, params: Obj = {}): { action: Action; out: Ref } {
  const uuid = randomUUID().toUpperCase();
  return { action: act(id, { UUID: uuid, ...params }), out: output(uuid, name) };
}

const CLOCK = (intent: string) => ({
  AppIntentDescriptor: { AppIntentIdentifier: intent, BundleIdentifier: "com.apple.mobiletimer", Name: "Clock", TeamIdentifier: "0000000000" },
});

// The phone actions: one If per action word the server can send (src/steps.ts ACTIONS).
function phoneSteps(step: Ref): Action[] {
  const get = (key: string) => producing("getvalueforkey", "Dictionary Value", { WFDictionaryKey: key, WFInput: attachment(step) });
  const asText = (ref: Ref) => producing("gettext", "Text", { WFTextActionText: text(ref) });

  const doValue = get("do");
  const doText = asText(doValue.out);
  const when = (word: string, body: () => Action[]) => ifBlock(doText.out, "is", word, body());

  const onOff = (whenOn: Action, whenOff: Action) => () => {
    const state = get("text");
    const stateText = asText(state.out);
    return [state.action, stateText.action, ...ifBlock(stateText.out, "is", "on", [whenOn], [whenOff])];
  };
  const level = (id: string, key: string) => () => {
    const l = get("level");
    return [l.action, act(id, { [key]: attachment(l.out) })];
  };

  return [
    doValue.action,
    doText.action,
    ...when("next", () => [act("skipforward")]),
    ...when("previous", () => [act("skipback", { WFSkipBackBehavior: "Previous Song" })]),
    ...when("pause", () => [act("pausemusic", { WFPlayPauseBehavior: "Pause" })]),
    ...when("play", () => [act("pausemusic", { WFPlayPauseBehavior: "Play" })]),
    ...when("volume", level("setvolume", "WFVolume")),
    ...when("brightness", level("setbrightness", "WFBrightness")),
    ...when("flashlight", onOff(act("flashlight", { state: 1 }), act("flashlight", { state: 0 }))),
    // Do Not Disturb is the Focus the action uses when none is named.
    ...when("focus", onOff(act("dnd.set", { Enabled: 1 }), act("dnd.set", { Enabled: 0 }))),
    ...when("timer", () => {
      const secs = get("value");
      return [
        secs.action,
        act("timer.start", {
          ...CLOCK("INCreateTimerIntent"),
          WFDuration: { Value: { Magnitude: secs.out, Unit: "sec" }, WFSerializationType: "WFQuantityFieldValue" },
        }),
      ];
    }),
    ...when("alarm", () => {
      const at = get("text");
      return [
        at.action,
        act("com.apple.mobiletimer-framework.MobileTimerIntents.MTCreateAlarmIntent", {
          ...CLOCK("CreateAlarmIntent"),
          dateComponents: text(at.out),
          name: "Alfred",
        }),
      ];
    }),
    ...when("open", () => {
      const url = get("url");
      return [url.action, act("openurl", { WFInput: attachment(url.out) })];
    }),
  ];
}

export interface ShortcutOptions {
  url: string; // https://<mac>.<tailnet>.ts.net/command
  key: string; // ALFRED_KEY
  typed?: boolean; // "Type to Alfred": always ask for typed input
}

export function alfredShortcut({ url, key, typed = false }: ShortcutOptions): Obj {
  const device = producing("getdevicedetails", "Device Model", { WFDeviceDetail: "Device Model" });
  const deviceText = producing("gettext", "Text", { WFTextActionText: text(device.out) });
  const setInput = (ref: Ref) => act("setvariable", { WFVariableName: "Input", WFInput: attachment(ref) });

  const ask = producing("ask", "Provided Input", { WFAskActionPrompt: "What should Alfred do?", WFInputType: "Text" });
  const listen = producing("dictatetext", "Dictated Text", { WFDictateTextStopListening: "After Pause" });
  const given = producing("detect.text", "Text", { WFInput: attachment(shortcutInput) });

  // Input: text handed to the shortcut (share sheet, Run Shortcut, Siri), else typed on a Mac or in
  // "Type to Alfred", else spoken on the iPhone.
  const input = typed
    ? [ask.action, setInput(ask.out)]
    : ifBlock(shortcutInput, "hasAnyValue", null, [given.action, setInput(given.out)], [
        ...ifBlock(deviceText.out, "contains", "iPhone", [listen.action, setInput(listen.out)], [ask.action, setInput(ask.out)]),
      ]);

  const now = producing("format.date", "Formatted Date", {
    WFDate: text(currentDate),
    WFDateFormatStyle: "ISO 8601",
    WFISO8601IncludeTime: true,
  });
  const reply = producing("downloadurl", "Contents of URL", {
    WFURL: url,
    WFHTTPMethod: "POST",
    WFHTTPBodyType: "JSON",
    ShowHeaders: true,
    WFHTTPHeaders: fields([["Authorization", `Bearer ${key}`]]),
    WFJSONValues: fields([
      ["text", variable("Input")],
      ["now", now.out],
      ["device", deviceText.out],
    ]),
  });
  const say = producing("getvalueforkey", "Dictionary Value", { WFDictionaryKey: "say", WFInput: attachment(reply.out) });
  const steps = producing("getvalueforkey", "Dictionary Value", { WFDictionaryKey: "steps", WFInput: attachment(reply.out) });

  const actions: Action[] = [
    device.action,
    deviceText.action,
    ...input,
    now.action,
    reply.action,
    say.action,
    ...ifBlock(say.out, "hasAnyValue", null, [act("speaktext", { WFText: text(say.out), WFSpeakTextWait: true })]),
    steps.action,
    ...repeatEach(steps.out, phoneSteps(variable("Repeat Item"))),
  ];

  return {
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "4033.0.4.3", // iOS/macOS 26: imports on 26 and 27 without old-format migrations
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59780 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: ["WFStringContentItem", "WFRichTextContentItem", "WFURLContentItem", "WFGenericFileContentItem"],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowHasShortcutInputVariables: !typed,
    WFWorkflowHasOutputFallback: false,
    WFQuickActionSurfaces: [],
    WFWorkflowTypes: ["WFWorkflowTypeShowInSearch"],
  };
}
