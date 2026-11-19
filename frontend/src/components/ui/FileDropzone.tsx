import { useRef, useState } from 'react';
import { Upload, Replace, Trash2, FileText as FileIcon } from 'lucide-react';
import type { MediaType } from '../../types';
export interface FileDropProps { mediaType: MediaType; file: File|null; onFile:(file:File)=>void; onRemove:()=>void; }
export default function FileDropzone({mediaType,file,onFile,onRemove}:FileDropProps){
 const input=useRef<HTMLInputElement>(null); const [drag,setDrag]=useState(false);
 const accept={image:'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',video:'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm',audio:'audio/wav,audio/wave,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus',text:'text/plain,.txt'}[mediaType];
 const choose=(list:FileList|null)=>{if(list?.[0])onFile(list[0])};
 return <div className={`dropzone ${drag?'drag':''}`} role="button" tabIndex={0} aria-label={`Choose or drop ${mediaType} media`} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ') input.current?.click()}} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);choose(e.dataTransfer.files)}}>
 <input ref={input} type="file" accept={accept} onChange={e=>choose(e.target.files)} hidden aria-label={`Select ${mediaType} file`}/><div className="drop-icon">{file?<FileIcon/>:<Upload/>}</div>{file?<><div className="file-meta"><strong>{file.name}</strong><span>{(file.size/1024/1024).toFixed(2)} MB</span></div><div className="file-actions"><button type="button" className="button secondary small" onClick={e=>{e.stopPropagation();input.current?.click()}}><Replace size={15}/>Replace</button><button type="button" className="icon-button" onClick={e=>{e.stopPropagation();onRemove()}} aria-label="Remove media"><Trash2 size={17}/></button></div></>:<><strong>Drop {mediaType} media here</strong><span>or</span><button type="button" className="button secondary" onClick={e=>{e.stopPropagation();input.current?.click()}}>Choose file</button></>}</div>
}
