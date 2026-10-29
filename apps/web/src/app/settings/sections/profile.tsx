'use client';

import { useEffect, useState } from 'react';
import { ProfileFields } from '@profullstack/profile/react';
import type { ProfileField } from '@profullstack/profile';
import { SectionShell } from '../shared';

type Values = Partial<Record<ProfileField, string | null>>;
const FIELDS: ProfileField[] = ['email', 'first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url'];

// Profile fields shared across Profullstack properties, read and written
// through /api/v1/me/profile.
export function ProfileSection() {
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/v1/me/profile', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const p = body?.profile ?? {};
        setValues(Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? ''])));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const onSave = async () => {
    setErrors({});
    const r = await fetch('/api/v1/me/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErrors(body.errors ?? {});
      throw new Error(body.error ?? 'Could not save.');
    }
  };

  return (
    <SectionShell title="Profile" description="Your name, company and role." onSave={onSave}>
      <ProfileFields idPrefix="settings-" values={values} onChange={setValues} errors={errors} disabled={!loaded} />
    </SectionShell>
  );
}
