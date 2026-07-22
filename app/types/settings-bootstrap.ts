export type SettingsRole = 'ADMIN' | 'HR' | 'EMPLOYEE';

export interface SettingsMemberProfile {
  id: string;
  name: string;
  email: string;
  role: SettingsRole;
  department: string;
  title: string;
  avatar?: string | null;
  phone?: string | null;
  bio?: string | null;
  skills: string[];
  startDate?: string | null;
  status: string;
  lastActiveAt?: string | null;
}

export interface SettingsUiPreferences {
  theme: string;
  density: string;
  type: string;
  accent: string;
  layout: string;
  icons: string;
  [key: string]: unknown;
}

export interface SettingsNotificationChannels {
  inApp: boolean;
  email: boolean;
}

export type SettingsNotificationPreferences = Record<string, Partial<SettingsNotificationChannels>>;

export interface SettingsBootstrap {
  profile: SettingsMemberProfile;
  preferences: Partial<SettingsUiPreferences>;
  notificationPreferences: SettingsNotificationPreferences;
}
