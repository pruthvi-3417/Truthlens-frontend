import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Download, Eye, Trash2 } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { EmptyState, ErrorState, StatusBadge } from '../components/ui/Common';
import ConfirmationDialog from '../components/ui/ConfirmationDialog';
import { deleteInvestigation, readInvestigationHistory, type StoredInvestigation } from '../lib/investigationStore';

type MediaFilter = 'All'|'Image'|'Video'|'Audio'|'Text';
type StatusFilter = 'All'|'Pending'|'Processing'|'Completed'|'Failed'|'Inconclusive';
type SortOption = 'Newest first'|'Oldest first'|'Filename';

const statusClass = (status: StoredInvestigation['status']) =>
 status === 'completed' ? 'cyan' : status === 'failed' ? 'red' : status === 'pending' || status === 'running' ? 'amber' : 'neutral';

const displayStatus = (status: StoredInvestigation['status']) =>
 status === 'running' ? 'Processing' : status === 'pending' ? 'Pending' : status === 'inconclusive' ? 'Inconclusive' : status.charAt(0).toUpperCase()+status.slice(1);

export default function History(){
 const [query,setQuery]=useState('');
 const [mediaFilter,setMediaFilter]=useState<MediaFilter>('All');
 const [statusFilter,setStatusFilter]=useState<StatusFilter>('All');
 const [sort,setSort]=useState<SortOption>('Newest first');
 const [records,setRecords]=useState<StoredInvestigation[]>([]);
 const [error,setError]=useState<string>();
 const [deleteTarget,setDeleteTarget]=useState<StoredInvestigation>();
 const navigate=useNavigate();

 useEffect(()=>{
  const refresh=()=>{const result=readInvestigationHistory();setRecords(result.records);setError(result.error)};
  refresh();
  window.addEventListener('storage',refresh);
  return()=>window.removeEventListener('storage',refresh);
 },[]);

 const filtered=[...records].filter(record=>{
  const term=query.trim().toLowerCase();
  const searchMatch=!term||record.filename.toLowerCase().includes(term)||record.id.toLowerCase().includes(term);
  const mediaMatch=mediaFilter==='All'||record.mediaType.toLowerCase()===mediaFilter.toLowerCase();
  const expectedStatus=statusFilter==='All'?undefined:statusFilter==='Processing'?'running':statusFilter.toLowerCase();
  const statusMatch=!expectedStatus||record.status===expectedStatus;
  return searchMatch&&mediaMatch&&statusMatch;
 }).sort((a,b)=>{
  if(sort==='Filename') return a.filename.localeCompare(b.filename);
  if(sort==='Oldest first') return a.submittedAt.localeCompare(b.submittedAt);
  return b.submittedAt.localeCompare(a.submittedAt);
 });

 const openRecord=(record:StoredInvestigation)=>{
  if(record.status==='completed'||record.status==='inconclusive') navigate('/results',{state:record.result?{result:record.result}:undefined});
  else navigate('/processing',{state:{job:{jobId:record.id,status:record.status==='running'?'running':record.status,statusUrl:record.statusUrl}}});
 };

 const downloadReport=(record:StoredInvestigation)=>{
  if(!record.reportUrl) return;
  const anchor=document.createElement('a');
  anchor.href=record.reportUrl;
  anchor.download='';
  anchor.rel='noopener';
  anchor.click();
 };

 const confirmDelete=()=>{
  if(!deleteTarget)return;
  deleteInvestigation(deleteTarget.id);
  setRecords(readInvestigationHistory().records);
  setDeleteTarget(undefined);
 };

 return <>
  <PageHeader title="Scan history" description="Review and manage stored investigation records."/>
  {error&&<ErrorState title="History unavailable" message={error} action={<button className="button secondary" onClick={()=>window.location.reload()}>Retry</button>}/>}
  <div className="history-toolbar">
   <label className="search-box"><Search/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search filename or investigation ID"/></label>
   <label className="select-filter">Media<select value={mediaFilter} onChange={event=>setMediaFilter(event.target.value as MediaFilter)}><option>All</option><option>Image</option><option>Video</option><option>Audio</option><option>Text</option></select></label>
   <label className="select-filter">Status<select value={statusFilter} onChange={event=>setStatusFilter(event.target.value as StatusFilter)}><option>All</option><option>Pending</option><option>Processing</option><option>Completed</option><option>Failed</option><option>Inconclusive</option></select></label>
   <label className="select-filter">Sort<select value={sort} onChange={event=>setSort(event.target.value as SortOption)}><option>Newest first</option><option>Oldest first</option><option>Filename</option></select></label>
  </div>
  <div className="card history-card">
   {filtered.length===0?<EmptyState title={records.length===0?'No investigations yet':'No investigations found'} message={records.length===0?'No legitimate investigation records exist in this browser.':'No investigation matches the active search and filters.'} action={<button className="button primary" onClick={()=>navigate('/analyze')}>Start an investigation</button>}/>:<div className="history-table-wrap"><table className="history-table"><thead><tr><th>File name</th><th>Media type</th><th>Submission date</th><th>Status</th><th>Investigation ID</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map(record=>{const date=new Date(record.submittedAt);return <tr key={record.id}><td><div className="history-file"><strong>{record.filename}</strong></div></td><td><span className="media-type-label">{record.mediaType}</span></td><td>{Number.isNaN(date.getTime())?'Unavailable':date.toLocaleString()}</td><td><StatusBadge tone={statusClass(record.status)}>{displayStatus(record.status)}</StatusBadge></td><td><code className="investigation-id">{record.id}</code></td><td><div className="history-actions"><button className="icon-button" type="button" aria-label={`View ${record.filename}`} title="View details" onClick={()=>openRecord(record)}><Eye size={16}/></button>{record.reportUrl&&<button className="icon-button" type="button" aria-label={`Download report for ${record.filename}`} title="Download report" onClick={()=>downloadReport(record)}><Download size={16}/></button>}<button className="icon-button danger-icon" type="button" aria-label={`Delete ${record.filename}`} title="Delete record" onClick={()=>setDeleteTarget(record)}><Trash2 size={16}/></button></div></td></tr>})}</tbody></table></div>}
  </div>
  <ConfirmationDialog open={Boolean(deleteTarget)} title="Delete investigation record?" message={deleteTarget?`This removes ${deleteTarget.filename} from local History. It cannot delete a backend investigation.`:''} confirmLabel="Delete record" onClose={()=>setDeleteTarget(undefined)} onConfirm={confirmDelete}/>
 </>;
}
