import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WifiOff, Circle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { pollAnalysisJob, type AnalysisJob } from '../services/analysisAdapter';
import { updateInvestigationStatus } from '../lib/investigationStore';

const stages=['Media validation','Media decoding','Metadata extraction','Image forensic examination','Video frame analysis','Audio signal examination','Text analysis','Cross-modal correlation','Evidence aggregation','Report generation'];

export default function Processing(){
 const navigate=useNavigate();
 const location=useLocation();
 const initialJob=(location.state as {job?: AnalysisJob}|null)?.job;
 const [job,setJob]=useState<AnalysisJob|undefined>(initialJob);
 const [error,setError]=useState('');
 const controllerRef=useRef<AbortController | undefined>(undefined);

 useEffect(()=>{
  if(!initialJob) return;
  const controller=new AbortController();
  controllerRef.current=controller;
  pollAnalysisJob(initialJob,{signal:controller.signal,onStatus:(updated)=>{setJob(updated); if(updated.status==='failed'||updated.status==='completed') updateInvestigationStatus(initialJob.jobId,updated.status)}}).then((completed)=>{
   setJob(completed); if(completed.status==='failed'||completed.status==='completed') updateInvestigationStatus(initialJob.jobId,completed.status);
   if(completed.status==='completed') navigate('/results',{replace:true,state:{result:completed.result}});
  }).catch((e)=>{
   if(e instanceof DOMException && e.name==='AbortError') setError('Polling cancelled');
   else setError(e instanceof Error?e.message:'Unable to retrieve analysis status');
  });
  return()=>controller.abort();
 },[initialJob,navigate]);

 const cancel=()=>controllerRef.current?.abort();
 const statusLabel=job?.status ?? 'unavailable';
 return <>
  <PageHeader title="Processing investigation" description="Analysis progress is shown only from confirmed backend events." actions={job&&<button className="button secondary" onClick={cancel}>Cancel polling</button>}/>
  <div className="processing-grid">
   <section className="card processing-status">
    <div className="engine-state"><WifiOff/><div><span>BACKEND STATUS</span><h3>{initialJob?'Backend job in progress':'Forensic engine not connected'}</h3><p>{initialJob?'Waiting for status events from the configured backend.':'No backend submission or job was received. No stages have been confirmed.'}</p></div></div>
    {error&&<div className="validation-error">{error}</div>}
    <div className="stages">{stages.map((stage,i)=>{
     return <div className="stage" key={stage}><Circle size={18}/><div><span>{String(i+1).padStart(2,'0')}</span><strong>{stage}</strong></div><em>Unconfirmed</em></div>
    })}</div>
   </section>
   <aside className="card"><div className="card-header"><span>PROCESSING DETAILS</span><h3>Connection state</h3></div><div className="detail-list"><div><span>Status</span><strong>{statusLabel}</strong></div><div><span>Job ID</span><strong>{job?.jobId ?? 'Unavailable'}</strong></div><div><span>Progress</span><strong>Backend events only</strong></div><div><span>Events</span><strong>{initialJob?'Polling configured endpoint':'No backend events'}</strong></div></div></aside>
  </div>
 </>;
}
