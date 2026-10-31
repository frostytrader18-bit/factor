import { Activity, Check, ChevronDown } from 'lucide-react';

export type ActivityRecord = {
  id: number;
  time: string;
  title: string;
  detail: string;
  tone: 'cyan' | 'blue' | 'violet' | 'gold' | 'green';
};

type ActivityLogViewProps = {
  entries: ActivityRecord[];
};

const toneStyles: Record<ActivityRecord['tone'], string> = {
  cyan: 'border-[#2a8588]/60 bg-[#103334] text-[#74e2d6]',
  blue: 'border-[#397cad]/60 bg-[#122c48] text-[#7fcaff]',
  violet: 'border-[#7453ae]/60 bg-[#282044] text-[#c5a5ff]',
  gold: 'border-[#8b6d35]/60 bg-[#382d18] text-[#e4c66f]',
  green: 'border-[#3e8968]/60 bg-[#173427] text-[#8be0b1]',
};

export function ActivityLogView({ entries }: ActivityLogViewProps) {
  return (
    <details data-testid="view-activity-log" className="gold-frame rounded-xl bg-[#0e171f]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 transition hover:bg-white/[.025] [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#2a8588]/60 bg-[#103334] text-[#74e2d6]"><Activity size={15} /></span>
          <span className="min-w-0">
            <span className="block text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">RECENT ACTIVITY</span>
            <span className="mt-0.5 block truncate font-mono-ui text-[8px] text-[#82939a]">Local interface events · newest first</span>
          </span>
          <span className="shrink-0 rounded-full border border-[#2a8588]/60 bg-[#103334]/60 px-2 py-1 font-mono-ui text-[8px] font-bold text-[#8fe6db]">{entries.length}</span>
        </span>
        <ChevronDown size={15} className="shrink-0 text-[#82939a] transition-transform details-chevron" />
      </summary>
      <div className="border-t border-[#293944] px-3 py-3 sm:px-4">
        {entries.length > 0 ? (
          <ol className="max-h-[360px] space-y-2 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} data-testid={`activity-entry-${entry.id}`} className="flex gap-2.5 rounded-lg border border-[#263a47] bg-[#0c171e] p-2.5">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border ${toneStyles[entry.tone]}`}><Check size={13} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-[#d5e1e6]">{entry.title}</span>
                    <time className="font-mono-ui text-[8px] tracking-wider text-[#758894]">{entry.time}</time>
                  </span>
                  <span className="mt-1 block text-[9px] leading-relaxed text-[#8296a1]">{entry.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg border border-dashed border-[#344a56] bg-[#0c171e] px-4 py-6 text-center text-[10px] text-[#8296a1]">Activity will appear here as you use the workspace.</p>
        )}
        <p className="mt-3 border-t border-[#293944] pt-2 text-[8px] leading-relaxed text-[#82939a]">Activity is local to this page session and clears on reload. It does not record market feed data or account actions.</p>
      </div>
    </details>
  );
}
