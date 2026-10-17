import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { useT } from '@/shared/i18n/I18nProvider';
import { COUNTRIES } from '@/shared/lib/countries';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import type { Filters } from './useMatching';

export function FilterModal({ filters, onSave }: { filters: Filters; onSave(f: Filters): void }) {
  const ui = useUi();
  const open = ui.isOpen('filter');
  return (
    <Modal open={open} onClose={() => ui.close('filter')} title="Match preferences" size="sm">
      <FilterForm filters={filters} onSave={(f) => { onSave(f); ui.close('filter'); }} />
    </Modal>
  );
}

function FilterForm({ filters, onSave }: { filters: Filters; onSave(f: Filters): void }) {
  const t = useT();
  const ui = useUi();
  const { user } = useSession();
  const [draft, setDraft] = useState<Filters>(filters);
  const vip = Boolean(user?.isVip);

  return (
    <div className="space-y-5">
      {!vip && (
        <button onClick={() => { ui.close('filter'); ui.open('vip'); }} className="w-full flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-left">
          <Lock className="w-5 h-5 text-amber-400 shrink-0" aria-hidden="true" />
          <span className="text-sm text-amber-200">{t('Filters are a VIP feature. Upgrade to choose who you meet.')}</span>
        </button>
      )}
      <fieldset disabled={!vip} className="space-y-4 disabled:opacity-50">
        <legend className="sr-only">{t('Preferences')}</legend>
        <div role="radiogroup" aria-label={t('Show me')} className="grid grid-cols-3 gap-2">
          {(['both', 'female', 'male'] as const).map((g) => (
            <button key={g} role="radio" aria-checked={draft.gender === g} onClick={() => setDraft({ ...draft, gender: g })}
              className={`py-2.5 rounded-xl text-sm font-bold border ${draft.gender === g ? 'border-[#00E676] bg-[#00E676]/15 text-[#00E676]' : 'border-white/10 text-gray-300'}`}>
              {g === 'both' ? t('Everyone') : g === 'female' ? t('Women') : t('Men')}
            </button>
          ))}
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Country')}</span>
          <select value={draft.country} onChange={(e) => setDraft({ ...draft, country: e.target.value })} className="w-full bg-gray-900 rounded-xl px-4 py-3 border border-gray-800">
            <option value="All Countries">{t('All Countries')}</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.name}>{c.flag} {c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/5">
          <span><span className="block font-bold text-sm">{t('Super match')}</span><span className="block text-xs text-gray-400">{t('Only real people, never demo profiles')}</span></span>
          <input type="checkbox" role="switch" checked={draft.superMatch} onChange={(e) => setDraft({ ...draft, superMatch: e.target.checked })} className="w-5 h-5 accent-[#00E676]" />
        </label>
      </fieldset>
      <Button className="w-full" onClick={() => onSave(vip ? draft : { ...draft, gender: 'both', country: 'All Countries', superMatch: false })}>{t('Save')}</Button>
    </div>
  );
}
