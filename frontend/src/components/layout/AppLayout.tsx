import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, ScanLine, History, FlaskConical, FileText, Info, Settings, Menu, X, ChevronRight, Wifi, WifiOff } from 'lucide-react';
import { checkBackendConnection, getBackendConnectionStatus, type BackendConnectionStatus } from '../../services/analysisAdapter';

const nav = [
  ['Dashboard','/dashboard',LayoutDashboard],['Analyze Media','/analyze',ScanLine],['Scan History','/history',History],['Analysis Methods','/methods',FlaskConical],['Reports','/reports',FileText],['About','/about',Info],['Settings','/settings',Settings]
] as const;

export default function AppLayout(){
  const [open,setOpen]=useState(false); const [collapsed,setCollapsed]=useState(false); const loc=useLocation(); const [backendStatus,setBackendStatus]=useState<BackendConnectionStatus>(()=>getBackendConnectionStatus());
  useEffect(()=>{let active=true;checkBackendConnection().then(status=>{if(active)setBackendStatus(status)});return()=>{active=false}},[]);
  const backendLabel=backendStatus==='connected'? 'Engine connected':backendStatus==='configured'? 'Checking engine':backendStatus==='unknown'? 'Connection status unknown':backendStatus==='disconnected'? 'Engine disconnected':'Engine not configured';
  const title=(nav.find(([,path])=>path===loc.pathname)?.[0]) || 'TruthLens';
  return <div className="app-shell">
    {open && <button className="scrim" aria-label="Close navigation" onClick={()=>setOpen(false)} />}
    <aside className={`sidebar ${collapsed?'collapsed':''} ${open?'open':''}`}>
      <div className="brand"><div className="brand-mark">TL</div>{!collapsed&&<div><strong>TruthLens</strong><span>FORENSICS</span></div>}<button className="close-mobile" onClick={()=>setOpen(false)}><X size={18}/></button></div>
      <nav>{nav.map(([label,path,Icon])=>{const active=loc.pathname===path; return <NavLink key={path} to={path} className={active?'active':''} onClick={()=>setOpen(false)}><Icon size={19}/>{!collapsed&&<span>{label}</span>}</NavLink>})}</nav>
      <button className="collapse" onClick={()=>setCollapsed(v=>!v)} aria-label="Collapse sidebar"><ChevronRight size={17}/></button>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="menu-button" onClick={()=>setOpen(true)}><Menu size={20}/></button><div><div className="breadcrumbs">Workspace <ChevronRight size={12}/> {title}</div><h1>{title}</h1></div></div><div className="connection">{backendStatus==='connected'?<Wifi size={15}/>:<WifiOff size={15}/>}<span>{backendLabel}</span></div></header>
      <main className="page"><Outlet/></main>
    </div>
  </div>
}
