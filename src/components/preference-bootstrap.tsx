'use client';

import { useServerInsertedHTML } from 'next/navigation';

// Mirror saved appearance preferences onto <html> before streamed content is
// painted. The callback only contributes server-inserted head markup; this
// component renders no client-side script node during hydration.
const PREFERENCES_FOUC_SCRIPT = `(function(){try{var d=document.documentElement;var allow={density:['default','compact'],type:['default','lg'],accent:['quiet','bold'],layout:['rail','top'],icons:['numeric','architectural']};var def={density:'default',type:'default',accent:'quiet',layout:'rail',icons:'numeric'};var raw=localStorage.getItem('devfathom-prefs');var p=raw?JSON.parse(raw):{};Object.keys(allow).forEach(function(k){var v=p&&p[k];if(allow[k].indexOf(v)===-1)v=def[k];d.setAttribute('data-'+k,v);});var theme=localStorage.getItem('theme');theme=theme==='dark'?'dark':'light';d.setAttribute('data-theme',theme);d.style.colorScheme=theme;}catch(e){}})();`;

export function PreferenceBootstrap() {
  useServerInsertedHTML(() => (
    <script
      id="apply-user-preferences"
      dangerouslySetInnerHTML={{ __html: PREFERENCES_FOUC_SCRIPT }}
    />
  ));

  return null;
}
