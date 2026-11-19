import { useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import ConfirmationDialog from '../components/ui/ConfirmationDialog';

export type ThemePreference = 'dark' | 'light' | 'system';

export default function Settings() {
 const [theme,setTheme] = useState<ThemePreference>(() => {
   const saved = localStorage.getItem('truthlens-theme');
   return saved === 'light' || saved === 'system' ? saved : 'dark';
 });
 const [saveHistory,setSaveHistory] = useState(() => localStorage.getItem('truthlens-save-history') === 'true');
 const [confirm,setConfirm] = useState(false);

 useEffect(() => {
  localStorage.setItem('truthlens-theme',theme);
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themePreference = theme;
  if (theme !== 'system') return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'; };
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
 }, [theme]);

 useEffect(() => localStorage.setItem('truthlens-save-history',String(saveHistory)),[saveHistory]);

 return <>
  <PageHeader title="Settings" description="Configure functional local application preferences."/>
  <div className="settings-list">
   <section className="card setting-row"><div><h3>Theme preference</h3><p>Choose the interface appearance.</p></div><select value={theme} onChange={e=>setTheme(e.target.value as ThemePreference)}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></section>
   <section className="card setting-row"><div><h3>Save investigation history</h3><p>Store completed investigation metadata locally when supported.</p></div><label className="switch"><input type="checkbox" checked={saveHistory} onChange={e=>setSaveHistory(e.target.checked)}/><span/></label></section>
   <section className="card setting-row danger-row"><div><h3>Clear locally saved history</h3><p>Remove TruthLens investigation data stored in this browser.</p></div><button className="button danger" onClick={()=>setConfirm(true)}>Clear history</button></section>
  </div>
  <ConfirmationDialog open={confirm} title="Clear local history?" message="This removes locally saved TruthLens data from this browser. It cannot undo backend records." confirmLabel="Clear history" onClose={()=>setConfirm(false)} onConfirm={()=>{localStorage.removeItem('truthlens-history');localStorage.removeItem('truthlens-investigations');setConfirm(false)}}/>
 </>;
}
