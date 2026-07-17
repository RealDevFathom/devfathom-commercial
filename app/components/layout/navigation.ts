import {
  BarChart3,
  BriefcaseBusiness,
  ClipboardCheck,
  DollarSign,
  FileText,
  FolderKanban,
  LayoutDashboard,
  MessageSquare,
  Settings,
  ShieldCheck,
  StickyNote,
  Users,
  Video,
} from 'lucide-vue-next';
import type { Component } from 'vue';

export type NavigationGroup = 'Workspace' | 'Firm';

export interface NavigationItem {
  label: string;
  to: string;
  icon: Component;
  group: NavigationGroup;
  roles?: string[];
}

export const navigation: NavigationItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, group: 'Workspace' },
  { label: 'Projects', to: '/projects', icon: FolderKanban, group: 'Workspace' },
  { label: 'Clients', to: '/clients', icon: BriefcaseBusiness, group: 'Workspace' },
  { label: 'Notes', to: '/notes', icon: StickyNote, group: 'Workspace' },
  { label: 'Meetings', to: '/meetings', icon: Video, group: 'Workspace' },
  { label: 'Chat', to: '/chat', icon: MessageSquare, group: 'Workspace' },
  { label: 'Finance', to: '/finance', icon: DollarSign, group: 'Firm', roles: ['ADMIN'] },
  { label: 'Team', to: '/team', icon: Users, group: 'Firm' },
  { label: 'Reviews', to: '/reviews', icon: ClipboardCheck, group: 'Firm' },
  { label: 'Insights', to: '/team/stats', icon: BarChart3, group: 'Firm', roles: ['ADMIN'] },
  { label: 'HR', to: '/hr', icon: FileText, group: 'Firm', roles: ['ADMIN', 'HR'] },
  { label: 'Audit Log', to: '/audit-logs', icon: ShieldCheck, group: 'Firm', roles: ['ADMIN'] },
  { label: 'Settings', to: '/settings', icon: Settings, group: 'Firm' },
];

export const navigationGroups: NavigationGroup[] = ['Workspace', 'Firm'];

export const routeLabels: Record<string, string> = {
  ...Object.fromEntries(navigation.map((item) => [item.to, item.label])),
  '/projects/import': 'Import',
  '/email': 'Email',
  '/hr': 'HR & Leave',
  '/api-docs': 'API Access',
};

export function getVisibleNavigation(role?: string): NavigationItem[] {
  return navigation.filter((item) => !item.roles || item.roles.includes(role || 'EMPLOYEE'));
}

export function getBestNavigationMatch(path: string, items: NavigationItem[]): string | undefined {
  return items
    .filter((item) => path === item.to || path.startsWith(`${item.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
}
