import { useState } from 'react';
import toast from 'react-hot-toast';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

const REASONS = ['Inappropriate video stream content', 'Harassment or hate speech', 'Spam or advertising', 'Underage user', 'Other'];

export function ReportDialog({ userId, name, onClose }: { userId: string | null; name: string; onClose(): void }) {
  const t = useT();
  return (
    <Modal open={userId !== null} onClose={onClose} title={t('Report {name}', { name })} size="sm">
      {userId && <ReportForm userId={userId} onDone={onClose} />}
    </Modal>
  );
}

function ReportForm({ userId, onDone }: { userId: string; onDone(): void }) {
  const t = useT();
  const [reason, setReason] = useState(REASONS[0]!);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await unwrap(client.POST('/reports', { body: { reportedUserId: userId, reason, ...(details.trim() ? { details: details.trim() } : {}) } }));
      toast.success(t('Thanks — our team will review your report.'));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e, t('Failed to submit the report')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Reason')}</span>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-gray-900 rounded-xl px-4 py-3 border border-gray-800">
          {REASONS.map((r) => <option key={r} value={r}>{t(r)}</option>)}
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Details (optional)')}</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} rows={3} className="w-full bg-gray-900 rounded-xl px-4 py-3 border border-gray-800 resize-none" />
      </label>
      <Button variant="danger" className="w-full" loading={busy} onClick={submit}>{t('Submit report')}</Button>
    </div>
  );
}
