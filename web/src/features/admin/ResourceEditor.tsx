import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { errorMessage, isApiError } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'checkbox' | 'textarea' | 'select' | 'file';
  options?: string[];
  required?: boolean;
  hint?: string;
}

type Values = Record<string, string | number | boolean | File | undefined>;

/**
 * One dialog for every "create/edit a row" form. `onSubmit` receives only typed values; server field
 * errors (422) are shown under the matching input.
 */
export function ResourceEditor({ title, fields, initial, onClose, onSubmit }: {
  title: string; fields: Field[]; initial?: Values; onClose(): void; onSubmit(values: Values): Promise<unknown>;
}) {
  const [v, setV] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, initial?.[f.name] ?? (f.type === 'checkbox' ? false : f.type === 'number' ? '' : f.type === 'file' ? undefined : '')])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = fields.find((f) => f.type === 'file' && f.required && !initial && !(v[f.name] instanceof File));
    if (missing) { setErrors({ [missing.name]: 'Please choose a file' }); return; }
    setBusy(true); setErrors({});
    try {
      const out: Values = {};
      for (const f of fields) {
        const x = v[f.name];
        if (f.type === 'number') { if (x !== '' && x !== undefined) out[f.name] = Number(x); }
        else if (f.type === 'file') { if (x instanceof File) out[f.name] = x; }
        else out[f.name] = x as string | boolean;
      }
      await onSubmit(out);
      toast.success('Saved');
      onClose();
    } catch (err) {
      if (isApiError(err) && Object.keys(err.fieldErrors).length) { setErrors(err.fieldErrors); toast.error('Please check the highlighted fields'); }
      else toast.error(errorMessage(err, 'Could not save'));
    } finally { setBusy(false); }
  };

  const base = 'w-full bg-gray-900 border rounded-xl px-3 py-2 text-sm';
  return (
    <Modal open onClose={onClose} title={title} size="md" locked={busy}>
      <form onSubmit={submit} className="space-y-3">
        {fields.map((f) => {
          const id = `f-${f.name}`;
          const err = errors[f.name];
          const cls = `${base} ${err ? 'border-red-500' : 'border-gray-800'}`;
          return (
            <div key={f.name}>
              {f.type === 'checkbox' ? (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} />{f.label}</label>
              ) : (
                <>
                  <label htmlFor={id} className="block text-xs font-bold text-gray-400 uppercase mb-1">{f.label}</label>
                  {f.type === 'textarea' ? <textarea id={id} rows={8} className={cls} value={String(v[f.name] ?? '')} required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
                    : f.type === 'select' ? <select id={id} className={cls} value={String(v[f.name] ?? '')} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                    : f.type === 'file' ? <input id={id} type="file" accept="image/*" onChange={(e) => setV({ ...v, [f.name]: e.target.files?.[0] })} className="text-sm" />
                    : <input id={id} type={f.type ?? 'text'} className={cls} value={String(v[f.name] ?? '')} required={f.required} aria-invalid={err ? true : undefined} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />}
                </>
              )}
              {err ? <p role="alert" className="text-xs text-red-400 mt-1">{err}</p> : f.hint ? <p className="text-xs text-gray-500 mt-1">{f.hint}</p> : null}
            </div>
          );
        })}
        <Button type="submit" loading={busy} className="w-full">Save</Button>
      </form>
    </Modal>
  );
}
