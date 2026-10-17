import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin, fmtDate, type Row } from './adminApi';
import { ResourceEditor, type Field } from './ResourceEditor';
import { act, Badge, LinkButton, PageTitle, PagedTable, type Column } from './ui';

type Values = Record<string, string | number | boolean | File | undefined>;

interface Config<T extends Row> {
  title: string; noun: string; path: string; key: string; fields: Field[]; columns: Column<T>[];
  /** `list` = unpaged array endpoint, `paged` = offset-paged. */
  mode: 'list' | 'paged';
  /** Gift images need multipart. */
  multipart?: boolean;
}

function toForm(values: Values): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') f.append(k, v instanceof File ? v : String(v));
  return f;
}

function CrudPage<T extends Row>({ c }: { c: Config<T> }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: [c.key] });
  const list = useQuery({ queryKey: [c.key, 'all'], queryFn: () => admin.list<T>(c.path), enabled: c.mode === 'list' });

  const save = (values: Values) => {
    const isNew = editing === 'new';
    const url = isNew ? c.path : `${c.path}/${(editing as T).id}`;
    const p = c.multipart ? admin.upload(isNew ? 'POST' : 'PATCH', url, toForm(values)) : isNew ? admin.post(url, values) : admin.patch(url, values);
    return p.then((r) => { reload(); return r; });
  };
  const actions = (r: T) => (
    <>
      <LinkButton onClick={() => setEditing(r)}>Edit</LinkButton>
      <LinkButton danger onClick={() => act(() => admin.del(`${c.path}/${r.id}`), 'Deleted', reload, `Delete this ${c.noun}?`)}>Delete</LinkButton>
    </>
  );

  return (
    <>
      <PageTitle action={<Button onClick={() => setEditing('new')}>Add {c.noun}</Button>}>{c.title}</PageTitle>
      {c.mode === 'paged' ? <PagedTable<T> queryKey={c.key} path={c.path} columns={c.columns} actions={(r) => actions(r)} />
        : list.isPending ? <PageSpinner />
        : list.isError ? <EmptyState title="Could not load" text={errorMessage(list.error)} />
        : <ListTable rows={list.data.items} columns={c.columns} actions={actions} />}
      {editing && <ResourceEditor title={editing === 'new' ? `Add ${c.noun}` : `Edit ${c.noun}`} fields={c.fields} {...(editing !== 'new' ? { initial: editing as unknown as Values } : {})} onClose={() => setEditing(null)} onSubmit={save} />}
    </>
  );
}

function ListTable<T extends Row>({ rows, columns, actions }: { rows: T[]; columns: Column<T>[]; actions(r: T): React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-left text-xs uppercase text-gray-400"><tr>{columns.map((c) => <th key={c.header} scope="col" className="px-3 py-2">{c.header}</th>)}<th /></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id} className="border-t border-white/5">{columns.map((c) => <td key={c.header} className="px-3 py-2">{c.cell(r)}</td>)}<td className="px-3 py-2 text-right whitespace-nowrap">{actions(r)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={columns.length + 1} className="px-3 py-10 text-center text-gray-500">Nothing here yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const yes = (b: unknown) => (b ? <Badge tone="green">yes</Badge> : <Badge>no</Badge>);

export const Gifts = () => <CrudPage c={{
  title: 'Gifts', noun: 'gift', path: '/admin/gifts', key: 'admin-gifts', mode: 'list', multipart: true,
  fields: [{ name: 'name', label: 'Name', required: true }, { name: 'price', label: 'Price (gems)', type: 'number', required: true }, { name: 'giftImage', label: 'Image', type: 'file', required: true, hint: 'PNG, JPEG, WebP, GIF or SVG, max 512 KB' }],
  columns: [{ header: 'Image', cell: (g) => <img src={String(g.image)} alt="" className="w-10 h-10 object-contain" /> }, { header: 'Name', cell: (g) => String(g.name) }, { header: 'Price', cell: (g) => String(g.price) }, { header: 'Created', cell: (g) => fmtDate(g.createdAt) }],
}} />;

export const Packs = () => <CrudPage c={{
  title: 'Gem packs', noun: 'pack', path: '/admin/packs', key: 'admin-packs', mode: 'list',
  fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' }, { name: 'price', label: 'Price', type: 'number', required: true }, { name: 'gems', label: 'Gems', type: 'number', required: true }, { name: 'popular', label: 'Mark as most popular', type: 'checkbox' }, { name: 'googlePayId', label: 'Google Play product id' }, { name: 'applePayId', label: 'App Store product id' }],
  columns: [{ header: 'Name', cell: (p) => String(p.name) }, { header: 'Gems', cell: (p) => String(p.gems) }, { header: 'Price', cell: (p) => String(p.price) }, { header: 'Popular', cell: (p) => yes(p.popular) }],
}} />;

export const VipPlans = () => <CrudPage c={{
  title: 'VIP plans', noun: 'plan', path: '/admin/vip-plans', key: 'admin-vip', mode: 'list',
  fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' }, { name: 'priceGems', label: 'Price (gems)', type: 'number', required: true }, { name: 'durationDays', label: 'Duration (days)', type: 'number', required: true }, { name: 'popular', label: 'Mark as most popular', type: 'checkbox' }],
  columns: [{ header: 'Name', cell: (p) => String(p.name) }, { header: 'Price', cell: (p) => String(p.priceGems) }, { header: 'Days', cell: (p) => String(p.durationDays) }, { header: 'Popular', cell: (p) => yes(p.popular) }],
}} />;

export const Pages = () => <CrudPage c={{
  title: 'Pages', noun: 'page', path: '/admin/pages', key: 'admin-pages', mode: 'paged',
  fields: [{ name: 'title', label: 'Title', required: true }, { name: 'slug', label: 'Slug', required: true, hint: 'lowercase letters, numbers and dashes' }, { name: 'content', label: 'Content (HTML)', type: 'textarea', hint: 'Sanitised on save: scripts and event handlers are removed.' }, { name: 'showInFooter', label: 'Show in footer', type: 'checkbox' }, { name: 'isActive', label: 'Published', type: 'checkbox' }],
  columns: [{ header: 'Title', cell: (p) => String(p.title) }, { header: 'URL', cell: (p) => `/${String(p.slug)}` }, { header: 'Footer', cell: (p) => yes(p.showInFooter) }, { header: 'Published', cell: (p) => yes(p.isActive) }],
}} />;

export const DemoUsers = () => <CrudPage c={{
  title: 'Demo users', noun: 'demo user', path: '/admin/demo-users', key: 'admin-demo', mode: 'paged',
  fields: [{ name: 'name', label: 'Name', required: true }, { name: 'gender', label: 'Gender', type: 'select', options: ['female', 'male', 'other'] }, { name: 'age', label: 'Age', type: 'number' }, { name: 'country', label: 'Country' }, { name: 'countryCode', label: 'Country code (2 letters)' }, { name: 'videoUrl', label: 'Video URL', hint: 'https:// link to an mp4 shown as the "stranger"' }, { name: 'avatar', label: 'Avatar path' }, { name: 'likesCount', label: 'Likes', type: 'number' }, { name: 'isOnline', label: 'Appears online', type: 'checkbox' }],
  columns: [{ header: 'Name', cell: (u) => String(u.name) }, { header: 'Country', cell: (u) => String(u.country ?? '') }, { header: 'Online', cell: (u) => yes(u.isOnline) }, { header: 'Video', cell: (u) => (u.videoUrl ? 'yes' : '—') }],
}} />;
