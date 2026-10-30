import { Activity, AlertTriangle, Check, Clock3, MousePointerClick, Radio, Sparkles } from 'lucide-react';

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
    <section data-testid="view-activity-log" className="tab-view rise-in space-y-4">
      <section className="gold-frame vibrant-frame relative overflow-hidden rounded-[15px] bg-[#0e171f] p-4 sm:p-6">
        <div className="ambient-orb ambient-orb-a pointer-events-none absolute right-[-55px] top-[-90px] h-60 w-60 rounded-full bg-[#32cbb9]/[.08] blur-[75px]" />
        <div className="relative z-[1]">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2"><span className="h-[2px] w-5 bg-[#d3ad5b]" /><p className="font-mono-ui text-[9px] tracking-[.22em] text-[#d4b460]">LOCAL SESSION RECORD</p></div>
              <h1 className="font-display text-[28px] font-bold leading-none tracking-[.06em] text-[#eef1ee] sm:text-[34px]">ACTIVITY <span className="gradient-heading">LOG</span></h1>
              <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-[#91a1ad]">A record of interactions in this browser preview. These entries are local UI events, not market activity.</p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full border border-[#2a8588]/60 bg-[#103334]/60 px-2.5 py-1.5 font-mono-ui text-[9px] tracking-[.1em] text-[#8fe6db]"><Activity size={12} /> {entries.length} LOCAL EVENTS</span>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-[#293a46] bg-[#0c171e] p-3">
              <div className="flex items-center gap-2 text-[#79dacf]"><MousePointerClick size={15} /><span className="font-mono-ui text-[8px] tracking-[.13em]">EVENT SOURCE</span></div>
              <p className="mt-2 text-[11px] font-bold text-[#d2e1e7]">Interface controls</p>
            </div>
            <div className="rounded-xl border border-[#293a46] bg-[#0c171e] p-3">
              <div className="flex items-center gap-2 text-[#8ac7ff]"><Clock3 size={15} /><span className="font-mono-ui text-[8px] tracking-[.13em]">SESSION SCOPE</span></div>
              <p className="mt-2 text-[11px] font-bold text-[#d2e1e7]">This page session</p>
            </div>
            <div className="rounded-xl border border-[#8b6d35]/45 bg-[#211b12] p-3">
              <div className="flex items-center gap-2 text-[#e4c66f]"><AlertTriangle size={15} /><span className="font-mono-ui text-[8px] tracking-[.13em]">LIVE DATA</span></div>
              <p className="mt-2 text-[11px] font-bold text-[#e6d7ae]">Not connected</p>
            </div>
          </div>

          <section className="analysis-card card-cyan rounded-xl border border-[#30404c] bg-[#101b24]/90 p-3 sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#283b47] pb-3">
              <div className="flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-lg bg-[#173246] text-[#66c9e2]"><Activity size={15} /></div><div><h2 className="text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">RECENT EVENTS</h2><p className="font-mono-ui text-[8px] text-[#768a96]">NEWEST FIRST · LOCAL ONLY</p></div></div>
              <span className="hidden items-center gap-1.5 font-mono-ui text-[8px] tracking-wider text-[#8796a0] sm:flex"><Sparkles size={11} className="text-[#ba9cff]" /> PREVIEW MODE</span>
            </div>

            {entries.length > 0 ? (
              <ol className="space-y-2.5">
                {entries.map((entry) => (
                  <li key={entry.id} data-testid={`activity-entry-${entry.id}`} className="flex gap-3 rounded-xl border border-[#263a47] bg-[#0c171e] p-3 transition hover:border-[#436878] sm:p-4">
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${toneStyles[entry.tone]}`}><Check size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-[#d5e1e6]">{entry.title}</span>
                        <time className="font-mono-ui text-[8px] tracking-wider text-[#758894]">{entry.time}</time>
                      </span>
                      <span className="mt-1 block text-[10px] leading-relaxed text-[#8296a1]">{entry.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="rounded-xl border border-dashed border-[#344a56] bg-[#0c171e] px-4 py-10 text-center">
                <Activity className="mx-auto text-[#64d8cf]" size={22} />
                <p className="mt-3 text-[12px] font-bold text-[#d1e0e7]">No local events yet</p>
                <p className="mt-1 text-[10px] text-[#8296a1]">Use a dashboard control to add a preview event.</p>
              </div>
            )}
          </section>

          <p className="mt-4 flex items-start gap-2 border-t border-[#293944] pt-3 text-[9px] leading-relaxed text-[#82939a]"><Radio size={12} className="mt-0.5 shrink-0 text-[#67daca]" /> Activity is held in local component state and clears on reload. No market feed or account actions are recorded.</p>
        </div>
      </section>
    </section>
  );
}
