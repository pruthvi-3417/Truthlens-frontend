import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderSearch, CheckCircle2, Clock3, XCircle, Image, Video, AudioLines, TextCursorInput, History, Upload, Wifi, WifiOff } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import PageHeader from '../components/ui/PageHeader';
import { StatCard, EmptyState, StatusBadge } from '../components/ui/Common';
import { readInvestigations, type StoredInvestigation } from '../lib/investigationStore';
import { checkBackendConnection, getBackendConnectionStatus, type BackendConnectionStatus } from '../services/analysisAdapter';

export default function Dashboard() {
 const navigate=useNavigate();
 const [records,setRecords]=useState<StoredInvestigation[]>(()=>readInvestigations());
 const [connection,setConnection]=useState<BackendConnectionStatus>(()=>getBackendConnectionStatus());

 useEffect(()=>{
  let active=true;
  checkBackendConnection().then(status=>{if(active)setConnection(status)});
  const refresh=()=>setRecords(readInvestigations());
  window.addEventListener('storage',refresh);
  return()=>{active=false;window.removeEventListener('storage',refresh)};
 },[]);

 const total=records.length;
 const completed=records.filter(record=>record.status==='completed').length;
 const pending=records.filter(record=>record.status==='pending'||record.status==='running').length;
 const failed=records.filter(record=>record.status==='failed').length;
 const recent=[...records].sort((a,b)=>b.submittedAt.localeCompare(a.submittedAt)).slice(0,5);
 const distribution=[
  {name:'Image',count:records.filter(record=>record.mediaType==='image').length},
  {name:'Video',count:records.filter(record=>record.mediaType==='video').length},
  {name:'Audio',count:records.filter(record=>record.mediaType==='audio').length},
  {name:'Text',count:records.filter(record=>record.mediaType==='text').length},
 ];
 const connectionLabel=connection==='connected'?'Forensic engine connected':connection==='disconnected'?'Forensic engine disconnected':connection==='unknown'?'Connection status unavailable':connection==='configured'?'Checking forensic engine':'Engine not configured';
 const openAnalyze=(mediaType:'image'|'video'|'audio'|'text')=>navigate('/analyze',{state:{mediaType}});

 const openRecord=(record:StoredInvestigation)=>{
  if(record.status==='completed') navigate('/results',{state:record.result?{result:record.result}:undefined});
  else navigate('/processing',{state:{job:{jobId:record.id,status:record.status,statusUrl:record.statusUrl}}});
 };

 return <>
  <PageHeader title="Forensic overview" description="Local submission activity and configured backend state." actions={<button className="button primary" onClick={()=>navigate('/analyze')}><Plus size={17}/>New investigation</button>}/>
  <div className="dashboard-status"><div className="connection-card">{connection==='connected'?<Wifi/>:<WifiOff/>}<div><span>ENGINE CONNECTION</span><strong>{connectionLabel}</strong></div></div></div>
  <div className="stats-grid dashboard-stats">
   <StatCard icon={<FolderSearch/>} label="Submitted investigations" value={total}/>
   <StatCard icon={<CheckCircle2/>} label="Completed analyses" value={completed}/>
   <StatCard icon={<Clock3/>} label="Pending analyses" value={pending}/>
   <StatCard icon={<XCircle/>} label="Failed analyses" value={failed}/>
  </div>
  <div className="dashboard-grid">
   <section className="card recent-investigations">
    <div className="card-header"><span>RECENT INVESTIGATIONS</span><h3>Submission activity</h3></div>
    {recent.length===0?<EmptyState title="No investigations yet" message="Upload media to begin your first forensic examination." action={<button className="button secondary" onClick={()=>navigate('/analyze')}><Upload size={16}/>Upload media</button>}/>:<div className="investigation-list">
     {recent.map(record=>{
      const date=new Date(record.submittedAt);
      return <div className="investigation-row" key={record.id}><div className="investigation-name"><strong>{record.filename}</strong><span>{record.mediaType}</span></div><span>{Number.isNaN(date.getTime())?'Submission date unavailable':date.toLocaleString()}</span><StatusBadge tone={record.status==='completed'?'cyan':record.status==='failed'?'red':record.status==='pending'||record.status==='running'?'amber':'neutral'}>{record.status}</StatusBadge><button className="button secondary small" onClick={()=>openRecord(record)}>Open</button></div>;
     })}
    </div>}
   </section>
   <section className="card media-chart">
    <div className="card-header"><span>MEDIA DISTRIBUTION</span><h3>Submitted media types</h3></div>
    {total===0?<EmptyState title="No submission data" message="Media distribution appears after a submission is stored."/>:<div className="chart-wrap" aria-label="Media type submission chart"><ResponsiveContainer width="100%" height={220}><BarChart data={distribution} margin={{top:10,right:8,left:-18,bottom:0}}><CartesianGrid stroke="#253449" strokeDasharray="3 3"/><XAxis dataKey="name" tick={{fill:'#94A3B8',fontSize:11}}/><YAxis allowDecimals={false} tick={{fill:'#94A3B8',fontSize:11}}/><Tooltip cursor={{fill:'rgba(34,211,238,.04)'}} contentStyle={{background:'#111C2B',border:'1px solid #253449',borderRadius:'6px',fontSize:'12px'}}/><Bar dataKey="count" fill="#3B82F6" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div>}
   </section>
  </div>
  <section className="module-section"><div className="section-label"><span>QUICK ACTIONS</span></div><div className="quick-actions">
   <button onClick={()=>openAnalyze('image')}><Image/><div><strong>Analyze Image</strong><span>JPG, JPEG, PNG or WebP</span></div></button>
   <button onClick={()=>openAnalyze('video')}><Video/><div><strong>Analyze Video</strong><span>MP4, MOV or WebM</span></div></button>
   <button onClick={()=>openAnalyze('audio')}><AudioLines/><div><strong>Analyze Audio</strong><span>WAV, MP3 or M4A</span></div></button>
   <button onClick={()=>openAnalyze('text')}><TextCursorInput/><div><strong>Analyze Text</strong><span>Paste text or upload TXT</span></div></button>
   <button onClick={()=>navigate('/history')}><History/><div><strong>View History</strong><span>Review stored investigations</span></div></button>
  </div></section>
 </>;
}
