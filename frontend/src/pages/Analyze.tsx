import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Image, Video, AudioLines, TextCursorInput, Play, Trash2, WifiOff } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import FileDropzone from '../components/ui/FileDropzone';
import MediaPreview from '../components/ui/MediaPreview';
import { submitAnalysis, isBackendConfigured } from '../services/analysisAdapter';
import type { MediaType } from '../types';
import { saveInvestigation } from '../lib/investigationStore';

const types = [
  ['image', 'Image', Image], ['video', 'Video', Video],
  ['audio', 'Audio', AudioLines], ['text', 'Text', TextCursorInput],
] as const;

export default function Analyze() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialMediaType=(location.state as {mediaType?: MediaType}|null)?.mediaType;
  const [type, setType] = useState<MediaType>(initialMediaType ?? 'image');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const previewRef = useRef('');
  const [submitting, setSubmitting] = useState(false);
  const [abortController, setAbortController] = useState<AbortController>();

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const validate = (next: File) => {
    setError('');
    if (next.size > 250 * 1024 * 1024) { setError('File exceeds the 250 MB limit.'); return; }
    const ext = next.name.split('.').pop()?.toLowerCase();
    const mime = next.type.toLowerCase();
    const configs = {
      image: { extensions:['jpg','jpeg','png','webp'], mimes:['image/jpeg','image/png','image/webp'] },
      video: { extensions:['mp4','mov','webm'], mimes:['video/mp4','video/quicktime','video/webm'] },
      audio: { extensions:['wav','mp3','m4a','aac','ogg','oga','opus'], mimes:['audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp4','audio/x-m4a','audio/aac','audio/ogg','audio/opus'] },
      text: { extensions:['txt'], mimes:['text/plain'] },
    };
    const config = configs[type];
    const extensionValid = config.extensions.includes(ext || '');
    const expectedMime = type === 'video'
      ? ({ mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm' } as Record<string,string>)[ext || '']
      : undefined;
    const mimeValid = type !== 'video'
      ? (!mime || config.mimes.includes(mime))
      : (!mime || (expectedMime !== undefined && mime === expectedMime));
    if (!extensionValid || !mimeValid) { setError(`Unsupported ${type} format. ${type === 'video' ? 'Supported: MP4, MOV, and WEBM.' : 'Choose a supported file format.'}`); return; }
    if (preview) URL.revokeObjectURL(preview); const nextPreview = type === 'text' ? '' : URL.createObjectURL(next); setFile(next); setPreview(nextPreview);
    if (type === 'text') {
      next.text().then((content) => { setText(content); setError(''); }).catch(() => setError('Unable to read the selected text file.'));
    }
  };

  const clear = () => { if (preview) URL.revokeObjectURL(preview); setPreview('');  setFile(null); setText(''); setError(''); };
  const cancelSubmission = () => {
    abortController?.abort();
  };

  const submit = async () => {
    if (type === 'text' && !text.trim()) { setError('Enter text or upload a TXT file.'); return; }
    if (type !== 'text' && !file) { setError('Select media before starting analysis.'); return; }
    if (!isBackendConfigured()) { setError('Forensic engine not connected'); return; }

    const controller = new AbortController();
    setAbortController(controller);
    setSubmitting(true);
    setError('');
    try {
      const submission = await submitAnalysis({mediaType:type, file:file || undefined, text:type === 'text' ? text : undefined}, { signal: controller.signal });
      const recordId = submission.kind === 'job' ? submission.job?.jobId : submission.result?.id;
      saveInvestigation({
        id: recordId || `local-${Date.now()}`,
        filename: file?.name || 'Text submission',
        mediaType: type,
        submittedAt: new Date().toISOString(),
        status: submission.kind === 'job' ? 'pending' : 'completed',
        statusUrl: submission.kind === 'job' ? submission.job?.statusUrl : undefined,
        result: submission.kind === 'result' ? submission.result : undefined,
      });
      if (submission.kind === 'job' && submission.job) {
        navigate('/processing', { state: { job: submission.job } });
      } else {
        navigate('/results', { state: { result: submission.result } });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setError('Submission cancelled');
      else { setError(e instanceof Error ? e.message : 'Submission failed'); saveInvestigation({id:`failed-${Date.now()}`,filename:file?.name||'Text submission',mediaType:type,submittedAt:new Date().toISOString(),status:'failed'}); }
    } finally {
      setSubmitting(false);
      setAbortController(undefined);
    }
  };

  return <>
    <PageHeader title="Analyze media" description="Prepare evidence for forensic examination. Media stays local until submission." />
    <div className="analyze-layout">
      <section className="card evidence-panel">
        <div className="card-header"><span>01 / MEDIA SOURCE</span><h3>Select media type</h3></div>
        <div className="media-tabs">{types.map(([key,label,Icon]) => <button key={key} className={type === key ? 'active':''} onClick={()=>{setType(key);clear();}}><Icon/><span>{label}</span></button>)}</div>
        {type === 'text' ? <div className="text-source">
          <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Paste text for examination…" />
          <div className="text-tools"><span>{text.length} characters</span><button className="button secondary small" onClick={()=>{const input=document.createElement('input');input.type='file';input.accept='.txt,text/plain';input.onchange=()=>input.files?.[0]&&validate(input.files[0]);input.click();}}>Upload TXT</button></div>
        </div> : <>
          <FileDropzone mediaType={type} file={file} onFile={validate} onRemove={()=>{if(preview)URL.revokeObjectURL(preview);setPreview('');setFile(null);}} />
          {preview && file && <MediaPreview key={`${file.name}-${file.size}-${file.lastModified}`} file={file} mediaType={type} previewUrl={preview} />}
        </>}
        {error && <div className="validation-error">{error}</div>}
      </section>
      <aside className="card submit-panel">
        <div className="card-header"><span>02 / SUBMISSION</span><h3>Investigation</h3></div>
        <div className="submission-info"><div><span>Media type</span><strong>{types.find(t=>t[0]===type)?.[1]}</strong></div><div><span>Submission target</span><strong><span className="offline-dot"/>Own backend</strong></div></div>
        <div className="privacy-note"><WifiOff/><p>Local processing is not performed by this frontend. Configure the backend before submission.</p></div>
        <button className="button primary wide" onClick={submit} disabled={submitting}>{submitting ? 'Submitting…' : 'Start analysis'}{!submitting && <Play size={16}/>}</button>
        {submitting && <button className="button ghost wide" onClick={cancelSubmission}>Cancel submission</button>}
        {(file || text) && !submitting && <button className="button ghost wide" onClick={clear}><Trash2 size={15}/>Clear</button>}
      </aside>
    </div>
  </>;
}
