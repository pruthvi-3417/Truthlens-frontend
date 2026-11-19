import { useEffect, useState } from 'react';
import type { MediaType } from '../../types';

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  format?: string;
  size: number;
}

interface MediaPreviewProps {
  file: File;
  mediaType: MediaType;
  previewUrl: string;
}

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export default function MediaPreview({ file, mediaType, previewUrl }: MediaPreviewProps) {
  const [duration, setDuration] = useState<number>();
  const [thumbnail, setThumbnail] = useState<string>();
  const [width, setWidth] = useState<number>();
  const [height, setHeight] = useState<number>();

  useEffect(() => {
    if (mediaType === 'image') {
      const image = new Image();
      image.onload = () => { setWidth(image.naturalWidth); setHeight(image.naturalHeight); };
      image.onerror = () => { setWidth(undefined); setHeight(undefined); };
      image.src = previewUrl;
    }
  }, [file, mediaType, previewUrl]);

  const readVideoMetadata = (element: HTMLVideoElement) => {
    const videoDuration = Number.isFinite(element.duration) ? element.duration : undefined;
    setDuration(videoDuration); setWidth(element.videoWidth || undefined); setHeight(element.videoHeight || undefined);

    if (element.readyState >= 1) {
      const target = Number.isFinite(element.duration) ? Math.min(element.duration / 3, 1) : 0;
      element.currentTime = target;
    }
  };

  const captureThumbnail = (element: HTMLVideoElement) => {
    if (!element.videoWidth || !element.videoHeight) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(element.videoWidth, 640);
      canvas.height = Math.round(canvas.width * element.videoHeight / element.videoWidth);
      canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height);
      setThumbnail(canvas.toDataURL('image/jpeg', 0.75));
    } catch { setThumbnail(undefined); }
  };

  const readAudioMetadata = (element: HTMLAudioElement) => {
    const audioDuration = Number.isFinite(element.duration) ? element.duration : undefined;
    setDuration(audioDuration);
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds || !Number.isFinite(seconds)) return 'Duration unavailable';
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${minutes}:${remaining.toString().padStart(2, '0')}`;
  };

  return <div className="media-preview-local">
    {mediaType === 'image' && <img src={previewUrl} alt={`Preview of ${file.name}`} />}
    {mediaType === 'video' && <>
      {thumbnail && <img className="video-thumbnail" src={thumbnail} alt={`Thumbnail preview of ${file.name}`} />}
      <video
        src={previewUrl}
        controls
        preload="metadata"
        aria-label={`Video preview for ${file.name}`}
        onLoadedMetadata={(event) => readVideoMetadata(event.currentTarget)}
        onSeeked={(event) => captureThumbnail(event.currentTarget)}
        onError={() => { setDuration(undefined); setWidth(undefined); setHeight(undefined); }}
      />
    </>}
    {mediaType === 'audio' && <audio src={previewUrl} controls preload="metadata" aria-label={`Audio preview for ${file.name}`} onLoadedMetadata={(event) => readAudioMetadata(event.currentTarget)} onError={() => setDuration(undefined)} />}
    <div className="preview-details" aria-live="polite">
      <span>{file.name}</span>
      <span>{formatBytes(file.size)}</span>
      {(mediaType === 'video' || mediaType === 'audio') && <span>{formatDuration(duration)}</span>}
      {mediaType === 'video' && width && height && <span>{width} × {height} px</span>}
      {mediaType === 'image' && width && height && <span>{width} × {height} px</span>}
    </div>
  </div>;
}
