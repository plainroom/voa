import { formatRemindTime, parseRemindTime, presetTime, type RemindPreset } from "./remindTime";
import { Picker, PickerLayer } from "../ui";

const PRESETS: { id: RemindPreset; label: string }[] = [
  { id: "tonight", label: "Tonight" },
  { id: "tomorrow", label: "Tomorrow morning" },
  { id: "weekend", label: "This weekend" },
  { id: "nextWeek", label: "Next week" },
];

/** Remind me: the four presets and a free-text time. `opened` is when it opened (the presets count from it). */
export function RemindPicker({ opened, onPick, onClose }: { opened: Date; onPick: (until: Date) => void; onClose: () => void }) {
  return (
    <PickerLayer onClose={onClose}>
      <Picker
        items={PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          hint: formatRemindTime(presetTime(p.id, opened), opened),
        }))}
        freeText={{
          placeholder: "e.g. friday 2pm",
          parse: (text) => parseRemindTime(text, new Date()),
        }}
        onPick={(choice) => onPick("at" in choice ? choice.at : presetTime(choice.id as RemindPreset, opened))}
        onClose={onClose}
      />
    </PickerLayer>
  );
}
