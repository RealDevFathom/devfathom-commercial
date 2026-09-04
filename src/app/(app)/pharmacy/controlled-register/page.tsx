import type { Metadata } from 'next';
import { ControlledRegisterConsole } from '@/components/pharmacy/dispensing/controlled-register-console';
export const metadata: Metadata = { title: 'Controlled register' };
export default function ControlledRegisterPage() {
  return <ControlledRegisterConsole />;
}
