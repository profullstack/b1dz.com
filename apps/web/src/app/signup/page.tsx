import { guardProps, signupGuard } from '@/lib/auth-form-guard';
import { SignupForm } from './SignupForm';

// The form carries a token minted at render time, so this page must not be
// cached: a stale page would hand every visitor the same expiring token.
export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  return <SignupForm {...(await guardProps(signupGuard))} />;
}
