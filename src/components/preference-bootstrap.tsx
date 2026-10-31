// Mirror saved appearance preferences onto <html> before streamed content is
// painted. This stays a Server Component so the root layout emits one script
// in the document head without adding a hydrated client script node.
const PREFERENCES_FOUC_SCRIPT = `(function(){try{var d=document.documentElement;var allow={density:['default','compact'],type:['default','lg'],accent:['quiet','bold'],layout:['rail','top'],icons:['numeric','architectural']};var def={density:'default',type:'default',accent:'quiet',layout:'rail',icons:'numeric'};var raw=localStorage.getItem('devfathom-prefs');var p=raw?JSON.parse(raw):{};Object.keys(allow).forEach(function(k){var v=p&&p[k];if(allow[k].indexOf(v)===-1)v=def[k];d.setAttribute('data-'+k,v);});var theme=localStorage.getItem('theme');theme=theme==='dark'?'dark':'light';d.setAttribute('data-theme',theme);d.style.colorScheme=theme;}catch(e){}})();`;

export function PreferenceBootstrap({ nonce }: { nonce?: string }) {
  return (
    <script
      id="apply-user-preferences"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: PREFERENCES_FOUC_SCRIPT }}
    />
  );
}
