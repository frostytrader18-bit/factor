import { ArrowRight, Check, Clock3, Layers3, Radio, Sparkles } from 'lucide-react';

type CycleMapViewProps = {
  market: string;
  steps: string[];
  selectedStep: string;
  countdown: number;
  onSelectStep: (step: string) => void;
};

export function CycleMapView({
  market,
  steps,
  selectedStep,
  countdown,
  onSelectStep,
}: CycleMapViewProps) {
  const selectedIndex = steps.indexOf(selectedStep);

  return (
    <section data-testid="view-cycle-map" className="tab-view rise-in space-y-4">
      <section className="gold-frame vibrant-frame relative overflow-hidden rounded-[15px] bg-[#0e171f] p-4 sm:p-6">
        <div className="ambient-orb ambient-orb-b pointer-events-none absolute right-[-65px] top-[-90px] h-64 w-64 rounded-full bg-[#5d67ff]/[.09] blur-[75px]" />
        <div className="relative z-[1]">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2"><span className="h-[2px] w-5 bg-[#d3ad5b]" /><p className="font-mono-ui text-[9px] tracking-[.22em] text-[#d4b460]">PREVIEW VISUALIZATION</p></div>
              <h1 className="font-display text-[28px] font-bold leading-none tracking-[.06em] text-[#eef1ee] sm:text-[34px]">CYCLE <span className="gradient-heading">MAP</span></h1>
              <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-[#91a1ad]">Explore the sample scan sequence and choose a step to preview. This is a display-only cycle map, not a strategy or live market reading.</p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full border border-[#4a4aa2]/60 bg-[#201f53]/45 px-2.5 py-1.5 font-mono-ui text-[9px] tracking-[.1em] text-[#bcb6ff]"><Sparkles size={12} /> DEMO SEQUENCE</span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <section className="analysis-card card-cyan rounded-xl border border-[#30404c] bg-[#101b24]/90 p-4 sm:p-5">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#173246] text-[#66c9e2]"><Layers3 size={16} /></div>
                  <div><h2 className="text-[11px] font-extrabold tracking-[.1em] text-[#e3e8e6]">CANONICAL SEQUENCE</h2><p className="mt-0.5 font-mono-ui text-[9px] text-[#768a96]">LOCAL PREVIEW · NO SIGNALS GENERATED</p></div>
                </div>
                <span className="rounded-md border border-[#225a6a] bg-[#112a38] px-2.5 py-1.5 font-mono-ui text-[10px] text-[#71cce5]">NEXT IN <strong className="text-[#e3f8fa]">{countdown}s</strong></span>
              </div>

              <div className="space-y-2.5">
                {steps.map((step, index) => {
                  const isSelected = step === selectedStep;
                  const isBefore = index < selectedIndex;
                  return (
                    <div key={step} className="relative">
                      {index < steps.length - 1 && <div aria-hidden="true" className={`absolute bottom-[-14px] left-[19px] top-[42px] z-0 w-px ${isBefore ? 'bg-gradient-to-b from-[#47e0c6] to-[#4a9df3]' : 'bg-[#283b4a]'}`} />}
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        data-testid={`cycle-map-step-${index + 1}`}
                        onClick={() => onSelectStep(step)}
                        className={`relative z-[1] flex w-full items-center gap-3 rounded-xl border p-3 text-left transition sm:p-4 ${isSelected ? 'cycle-step-card-active border-[#4fbcf0]/70 bg-[#132b49] shadow-[0_0_22px_rgba(73,164,242,.14)]' : 'border-[#263b49] bg-[#0d1822] hover:border-[#4b6680]'}`}
                      >
                        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border font-mono-ui text-[11px] ${isSelected ? 'border-[#64ccff]/60 bg-gradient-to-br from-[#16729a] to-[#5143a3] text-white shadow-[0_0_18px_rgba(81,178,255,.3)]' : isBefore ? 'border-[#398e85]/70 bg-[#163c3b] text-[#7fe7ce]' : 'border-[#344452] bg-[#17232c] text-[#8296a4]'}`}>
                          {isBefore ? <Check size={17} /> : String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono-ui text-[8px] tracking-[.16em] text-[#78909d]">SEQUENCE STEP {String(index + 1).padStart(2, '0')}</span>
                          <span className={`mt-1 block text-[14px] font-bold ${isSelected ? 'text-[#e2f7ff]' : 'text-[#b7c6ce]'}`}>{step}</span>
                          <span className="mt-1 block text-[9px] text-[#748895]">{isSelected ? 'Selected for this local preview' : isBefore ? 'Earlier in the sample sequence' : 'Later in the sample sequence'}</span>
                        </span>
                        {isSelected && <span className="rounded-full border border-[#4aade1]/40 bg-[#103148] px-2 py-1 font-mono-ui text-[8px] tracking-wider text-[#90dcff]">SELECTED</span>}
                        {!isSelected && <ArrowRight size={15} className="shrink-0 text-[#617786]" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            <aside className="space-y-3">
              <section className="analysis-card timer-panel rounded-xl border border-[#34515f] bg-[#111e27] p-4">
                <div className="mb-3 flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-lg bg-[#38212c] text-[#f06b82]"><Clock3 size={15} /></div><div><h2 className="text-[10px] font-extrabold tracking-[.1em] text-[#e3e8e6]">PREVIEW TIMER</h2><p className="font-mono-ui text-[8px] text-[#778a95]">LOCAL COUNTDOWN ONLY</p></div></div>
                <div className="timer-card rounded-xl border p-4 text-center">
                  <p className="font-mono-ui text-[8px] tracking-[.18em] text-[#93b5c8]">NEXT CYCLE IN</p>
                  <p data-testid="cycle-map-countdown" className="countdown-number mt-1 font-display text-[54px] font-bold leading-none text-[#70c9ff]">{countdown}<span className="ml-1 text-[18px]">s</span></p>
                  <p className="mt-2 text-[9px] text-[#8aa0ae]">No market timing is active</p>
                </div>
              </section>

              <section className="analysis-card card-log rounded-xl border border-[#30404c] bg-[#101b24]/90 p-4">
                <div className="mb-3 flex items-center gap-2"><div className="grid h-8 w-8 place-items-center rounded-lg bg-[#183b3b] text-[#55d8c8]"><Radio size={15} /></div><div><h2 className="text-[10px] font-extrabold tracking-[.1em] text-[#e3e8e6]">PREVIEW CONTEXT</h2><p className="font-mono-ui text-[8px] text-[#778a95]">SAMPLE ONLY</p></div></div>
                <div className="space-y-2">
                  <div className="rounded-lg border border-[#293a46] bg-[#0c171e] p-3"><p className="font-mono-ui text-[8px] tracking-[.12em] text-[#748995]">SELECTED MARKET</p><p data-testid="cycle-map-market" className="mt-1 text-[11px] font-bold text-[#cfe4ed]">{market}</p></div>
                  <div className="rounded-lg border border-[#293a46] bg-[#0c171e] p-3"><p className="font-mono-ui text-[8px] tracking-[.12em] text-[#748995]">CURRENT STEP</p><p data-testid="cycle-map-selected-step" className="mt-1 text-[12px] font-bold text-[#9de6e0]">{selectedStep}</p></div>
                </div>
              </section>
            </aside>
          </div>

          <p className="mt-4 flex items-start gap-2 border-t border-[#293944] pt-3 text-[9px] leading-relaxed text-[#82939a]"><Radio size={12} className="mt-0.5 shrink-0 text-[#67daca]" /> Cycle positions are illustrative UI samples only. No live feed, prediction, or trading action is connected.</p>
        </div>
      </section>
    </section>
  );
}
