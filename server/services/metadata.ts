import exifr from 'exifr';
import sharp from 'sharp';
import type {
  AnalysisItem,
  MetadataConsistencyCheck,
  MetadataDetails,
  MethodDocumentation,
} from '../types.ts';

const EXPECTED_WHEN_EXIF_PRESENT = [
  'camera_make',
  'camera_model',
  'capture_datetime',
  'software',
  'orientation',
] as const;

const EDITING_SOFTWARE_KEYWORDS = [
  'photoshop',
  'gimp',
  'lightroom',
  'canva',
  'snapseed',
  'paint.net',
  'pixlr',
  'affinity',
  'vsco',
  'facetune',
  'picsart',
  'coreldraw',
  'imagemagick',
  'ffmpeg',
  'pillow',
  'sharp',
  'libvips',
] as const;

interface MetadataExtraction {
  imageFormat: string;
  exifPresent: boolean;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  orientation: number | string | null;
  captureDatetime: string | null;
  digitizedDatetime: string | null;
  modifyDatetime: string | null;
  colorSpace: string | null;
  exifVersion: string | null;
  software: string | null;
  gpsPresent: boolean;
  gpsFieldsPresent: string[];
  fieldsFound: string[];
  fieldsMissing: string[];
  parseErrors: string[];
  formatNotes: string | null;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  embeddedThumbnailPresent: boolean;
  embeddedThumbnailWidth: number | null;
  embeddedThumbnailHeight: number | null;
  pngTextTags: Record<string, string>;
  consistencyChecks: MetadataConsistencyCheck[];
}

export interface MetadataBuildOptions {
  decodedWidth?: number;
  decodedHeight?: number;
  containerNotes?: string[];
}

function asStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const text = Buffer.from(value).toString('utf-8').replace(/\0+$/g, '').trim();
    return text || null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (Array.isArray(value)) {
    const joined = value.map(String).join(' ').trim();
    return joined || null;
  }
  return String(value).trim() || null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const str = asStr(value);
  if (!str) return null;
  const parsed = Number.parseInt(str, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOrientation(value: unknown): number | string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const text = asStr(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return text;
}

function colorSpaceLabel(value: unknown): string | null {
  if (value === 1 || value === '1') return 'sRGB';
  if (value === 2 || value === '2') return 'Adobe RGB';
  if (value === 65535 || value === '65535') return 'Uncalibrated';
  return asStr(value);
}

function markFound(extraction: MetadataExtraction, name: string): void {
  if (!extraction.fieldsFound.includes(name)) {
    extraction.fieldsFound.push(name);
  }
}

function isGpsKey(key: string): boolean {
  return key.startsWith('GPS') || key === 'latitude' || key === 'longitude';
}

function parseExifDateMs(raw: string | null): number | null {
  if (!raw) return null;
  // Handle EXIF 'YYYY:MM:DD HH:MM:SS' as well as ISO strings
  const normalized = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : null;
}

function extractPngTextChunks(data: Buffer): Record<string, string> {
  const tags: Record<string, string> = {};
  if (data.length < 16) return tags;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47 ||
    data[4] !== 0x0d ||
    data[5] !== 0x0a
  ) {
    return tags;
  }
  let offset = 8;
  while (offset + 8 <= data.length) {
    const chunkLen = data.readUInt32BE(offset);
    const chunkType = data.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd + 4 > data.length) break;

    if (chunkType === 'tEXt' && chunkLen > 0 && chunkLen <= 4096) {
      const payload = data.subarray(dataStart, dataEnd);
      const nul = payload.indexOf(0);
      if (nul > 0) {
        const key = payload.subarray(0, nul).toString('latin1').trim();
        const val = payload.subarray(nul + 1).toString('latin1').trim();
        if (key && val) tags[key] = val.slice(0, 200);
      }
    } else if (chunkType === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }
  return tags;
}

function buildConsistencyChecks(
  extraction: MetadataExtraction,
  decodedWidth?: number,
  decodedHeight?: number,
  containerNotes: string[] = [],
): MetadataConsistencyCheck[] {
  const checks: MetadataConsistencyCheck[] = [];

  // 1. Chronology check
  const capMs = parseExifDateMs(extraction.captureDatetime);
  const digMs = parseExifDateMs(extraction.digitizedDatetime);
  const modMs = parseExifDateMs(extraction.modifyDatetime);
  if (capMs !== null || modMs !== null || digMs !== null) {
    const nowPlusDay = Date.now() + 24 * 60 * 60 * 1000;
    if (capMs !== null && modMs !== null && modMs + 60_000 < capMs) {
      checks.push({
        check_id: 'META-CHRONOLOGY',
        name: 'Timestamp chronology',
        status: 'inconsistent',
        observation: `ModifyDate (${extraction.modifyDatetime}) precedes DateTimeOriginal (${extraction.captureDatetime}).`,
        limitations: [
          'Incorrect camera clock settings or timezone resets during import can cause inverted file timestamps without editing.',
        ],
      });
    } else if (capMs !== null && capMs > nowPlusDay) {
      checks.push({
        check_id: 'META-CHRONOLOGY',
        name: 'Timestamp chronology',
        status: 'inconsistent',
        observation: `Capture timestamp (${extraction.captureDatetime}) lies more than 24 hours in the future relative to analysis time.`,
        limitations: ['Device system clock may simply have been misconfigured at capture.'],
      });
    } else if (capMs !== null && modMs !== null && modMs - capMs > 300_000) {
      checks.push({
        check_id: 'META-CHRONOLOGY',
        name: 'Timestamp chronology',
        status: 'informational',
        observation: `ModifyDate (${extraction.modifyDatetime}) is later than DateTimeOriginal (${extraction.captureDatetime}), consistent with post-capture export or re-save.`,
        limitations: ['Operating-system file saves or gallery exports routinely update ModifyDate.'],
      });
    } else {
      checks.push({
        check_id: 'META-CHRONOLOGY',
        name: 'Timestamp chronology',
        status: 'consistent',
        observation: 'Populated EXIF timestamps show internally coherent chronological ordering.',
        limitations: ['Timestamps are editable strings and do not verify true capture time.'],
      });
    }
  } else {
    checks.push({
      check_id: 'META-CHRONOLOGY',
      name: 'Timestamp chronology',
      status: 'unavailable',
      observation: 'Insufficient timestamp fields to evaluate chronological consistency.',
      limitations: ['Absence of EXIF timestamps is normal after web/messaging stripping or PNG export.'],
    });
  }

  // 2. EXIF dimension vs pixel dimension check
  if (
    extraction.exifImageWidth &&
    extraction.exifImageHeight &&
    decodedWidth &&
    decodedHeight
  ) {
    const exactMatch =
      extraction.exifImageWidth === decodedWidth && extraction.exifImageHeight === decodedHeight;
    const swappedMatch =
      extraction.exifImageWidth === decodedHeight && extraction.exifImageHeight === decodedWidth;
    if (exactMatch || swappedMatch) {
      checks.push({
        check_id: 'META-DIMENSIONS',
        name: 'EXIF vs pixel dimensions',
        status: 'consistent',
        observation: `EXIF dimension tags (${extraction.exifImageWidth}x${extraction.exifImageHeight}) match decoded pixel dimensions (${decodedWidth}x${decodedHeight}).`,
        limitations: ['Matching dimensions can also be written by export tools.'],
      });
    } else {
      checks.push({
        check_id: 'META-DIMENSIONS',
        name: 'EXIF vs pixel dimensions',
        status: 'inconsistent',
        observation: `EXIF dimension tags (${extraction.exifImageWidth}x${extraction.exifImageHeight}) differ from decoded pixels (${decodedWidth}x${decodedHeight}), suggesting resizing or cropping without tag update.`,
        limitations: ['Some legacy encoders omit updating PixelXDimension/PixelYDimension during thumbnail/preview export.'],
      });
    }
  } else {
    checks.push({
      check_id: 'META-DIMENSIONS',
      name: 'EXIF vs pixel dimensions',
      status: 'unavailable',
      observation: 'EXIF PixelXDimension/PixelYDimension tags were not present for pixel comparison.',
      limitations: ['Many cameras and PNG/WEBP containers do not populate ExifImageWidth/Height.'],
    });
  }

  // 3. Embedded thumbnail aspect/size consistency
  if (
    extraction.embeddedThumbnailPresent &&
    extraction.embeddedThumbnailWidth &&
    extraction.embeddedThumbnailHeight &&
    decodedWidth &&
    decodedHeight
  ) {
    const mainRatio = decodedWidth / decodedHeight;
    const thumbRatio = extraction.embeddedThumbnailWidth / extraction.embeddedThumbnailHeight;
    const swappedThumbRatio = extraction.embeddedThumbnailHeight / extraction.embeddedThumbnailWidth;
    const diffNormal = Math.abs(mainRatio - thumbRatio) / Math.max(mainRatio, 1e-6);
    const diffSwapped = Math.abs(mainRatio - swappedThumbRatio) / Math.max(mainRatio, 1e-6);
    const bestRatioDiff = Math.min(diffNormal, diffSwapped);

    if (
      extraction.embeddedThumbnailWidth > decodedWidth ||
      extraction.embeddedThumbnailHeight > decodedHeight
    ) {
      checks.push({
        check_id: 'META-THUMBNAIL',
        name: 'Embedded EXIF thumbnail consistency',
        status: 'inconsistent',
        observation: `Embedded EXIF thumbnail (${extraction.embeddedThumbnailWidth}x${extraction.embeddedThumbnailHeight}) is larger than decoded main image (${decodedWidth}x${decodedHeight}).`,
        limitations: ['Downscaling pipelines that preserve original APP1 headers can leave oversized legacy thumbnails.'],
      });
    } else if (bestRatioDiff > 0.15) {
      checks.push({
        check_id: 'META-THUMBNAIL',
        name: 'Embedded EXIF thumbnail consistency',
        status: 'informational',
        observation: `Embedded thumbnail aspect ratio (${thumbRatio.toFixed(2)}, ${extraction.embeddedThumbnailWidth}x${extraction.embeddedThumbnailHeight}) differs from main image (${mainRatio.toFixed(2)}, ${decodedWidth}x${decodedHeight}).`,
        limitations: [
          'Smartphones shooting 16:9 or cropped aspect ratios often embed uncropped 4:3 sensor previews inside the EXIF IFD1 thumbnail.',
        ],
      });
    } else {
      checks.push({
        check_id: 'META-THUMBNAIL',
        name: 'Embedded EXIF thumbnail consistency',
        status: 'consistent',
        observation: `Embedded EXIF thumbnail (${extraction.embeddedThumbnailWidth}x${extraction.embeddedThumbnailHeight}) matches the main image aspect ratio.`,
        limitations: ['Thumbnail aspect match does not compare pixel-level semantic content.'],
      });
    }
  } else {
    checks.push({
      check_id: 'META-THUMBNAIL',
      name: 'Embedded EXIF thumbnail consistency',
      status: 'unavailable',
      observation: 'No embedded EXIF IFD1 thumbnail was found.',
      limitations: ['Absence of an embedded thumbnail is normal and never indicates manipulation.'],
    });
  }

  // 4. Software & container tags check
  const softwareCandidate =
    extraction.software ?? extraction.pngTextTags.Software ?? extraction.pngTextTags.Creator ?? null;
  if (softwareCandidate) {
    const matchedEditor = EDITING_SOFTWARE_KEYWORDS.some((kw) =>
      softwareCandidate.toLowerCase().includes(kw),
    );
    checks.push({
      check_id: 'META-SOFTWARE',
      name: 'Capture vs processing software provenance',
      status: matchedEditor ? 'informational' : 'consistent',
      observation: matchedEditor
        ? `Processing or export software signature recorded (${softwareCandidate})${extraction.cameraModel ? ` alongside camera hardware (${extraction.cameraModel})` : ''}.`
        : `Software/firmware tag recorded (${softwareCandidate}).`,
      limitations: [
        'Software tags indicate export/processing lineage (which may be benign color correction or resizing) and can be stripped or edited.',
      ],
    });
  } else if (containerNotes.length > 0) {
    checks.push({
      check_id: 'META-SOFTWARE',
      name: 'Container & filename cross-check',
      status: 'informational',
      observation: containerNotes.join(' '),
      limitations: ['Filename extensions are user-editable and do not affect pixel decoding.'],
    });
  }

  return checks;
}

export async function extractMetadata(
  data: Buffer,
  imageFormat: string,
  options: MetadataBuildOptions = {},
): Promise<MetadataExtraction> {
  let fmt = (imageFormat || '').toUpperCase();
  if (fmt === 'JPG') fmt = 'JPEG';

  const pngTextTags = fmt === 'PNG' ? extractPngTextChunks(data) : {};

  const extraction: MetadataExtraction = {
    imageFormat: fmt,
    exifPresent: false,
    cameraMake: null,
    cameraModel: null,
    lens: null,
    orientation: null,
    captureDatetime: null,
    digitizedDatetime: null,
    modifyDatetime: null,
    colorSpace: null,
    exifVersion: null,
    software: pngTextTags.Software ?? null,
    gpsPresent: false,
    gpsFieldsPresent: [],
    fieldsFound: [],
    fieldsMissing: [],
    parseErrors: [],
    formatNotes: null,
    exifImageWidth: null,
    exifImageHeight: null,
    embeddedThumbnailPresent: false,
    embeddedThumbnailWidth: null,
    embeddedThumbnailHeight: null,
    pngTextTags,
    consistencyChecks: [],
  };

  if (pngTextTags.Software) {
    markFound(extraction, 'png_software');
  }

  if (fmt === 'PNG') {
    extraction.formatNotes =
      'PNG commonly lacks classic EXIF camera metadata; absence is normal and not evidence of manipulation.';
  } else if (fmt === 'WEBP') {
    extraction.formatNotes =
      'WEBP may omit EXIF depending on how the file was encoded; absence is common and not evidence of manipulation.';
  } else if (fmt === 'JPEG') {
    extraction.formatNotes =
      'JPEG may contain EXIF, but many platforms strip metadata during upload, export, or messaging.';
  }

  try {
    const parsed = (await exifr.parse(data, {
      tiff: true,
      exif: true,
      gps: true,
      interop: false,
      makerNote: false,
      userComment: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: false,
    })) as Record<string, unknown> | undefined;

    if (parsed && Object.keys(parsed).length > 0) {
      extraction.exifPresent = true;

      const gpsNames: string[] = [];
      for (const [key, rawVal] of Object.entries(parsed)) {
        if (isGpsKey(key)) {
          if (key.startsWith('GPS') && rawVal !== undefined && rawVal !== null) {
            gpsNames.push(key);
          }
          continue;
        }

        if (key === 'Make') {
          extraction.cameraMake = asStr(rawVal);
          if (extraction.cameraMake) markFound(extraction, 'camera_make');
        } else if (key === 'Model') {
          extraction.cameraModel = asStr(rawVal);
          if (extraction.cameraModel) markFound(extraction, 'camera_model');
        } else if (key === 'LensModel' || key === 'LensMake' || key === 'LensSpecification') {
          const decoded = asStr(rawVal);
          if (decoded && (!extraction.lens || key === 'LensModel')) {
            extraction.lens = decoded;
            markFound(extraction, 'lens');
          }
        } else if (key === 'Orientation') {
          extraction.orientation = asOrientation(rawVal);
          if (extraction.orientation !== null) markFound(extraction, 'orientation');
        } else if (key === 'DateTimeOriginal') {
          const decoded = asStr(rawVal);
          if (decoded) {
            extraction.captureDatetime = decoded;
            markFound(extraction, 'capture_datetime');
          }
        } else if (key === 'ModifyDate' || key === 'DateTime') {
          const decoded = asStr(rawVal);
          if (decoded) {
            extraction.modifyDatetime = decoded;
            if (!extraction.captureDatetime) {
              extraction.captureDatetime = decoded;
              markFound(extraction, 'capture_datetime');
            }
          }
        } else if (key === 'DateTimeDigitized' || key === 'CreateDate') {
          const decoded = asStr(rawVal);
          if (decoded) {
            extraction.digitizedDatetime = decoded;
            markFound(extraction, 'digitized_datetime');
          }
        } else if (key === 'Software') {
          const decoded = asStr(rawVal);
          if (decoded) {
            extraction.software = decoded;
            markFound(extraction, 'software');
          }
        } else if (key === 'ProcessingSoftware') {
          const decoded = asStr(rawVal);
          if (decoded && !extraction.software) {
            extraction.software = decoded;
            markFound(extraction, 'software');
          } else if (decoded) {
            markFound(extraction, 'processing_software');
          }
        } else if (key === 'ColorSpace') {
          const label = colorSpaceLabel(rawVal);
          if (label) {
            extraction.colorSpace = label;
            markFound(extraction, 'color_space');
          }
        } else if (key === 'ExifVersion') {
          const decoded = asStr(rawVal);
          if (decoded) {
            extraction.exifVersion = decoded;
            markFound(extraction, 'exif_version');
          }
        } else if (key === 'ExifImageWidth' || key === 'ImageWidth') {
          const dim = asInt(rawVal);
          if (dim && dim > 0) extraction.exifImageWidth = dim;
        } else if (key === 'ExifImageHeight' || key === 'ImageHeight') {
          const dim = asInt(rawVal);
          if (dim && dim > 0) extraction.exifImageHeight = dim;
        }
      }

      if (gpsNames.length > 0) {
        extraction.gpsPresent = true;
        extraction.gpsFieldsPresent = Array.from(new Set(gpsNames)).sort();
        markFound(extraction, 'gps');
      }
    }

    // Attempt optional embedded EXIF thumbnail inspection without mutating source
    try {
      const thumbRaw = await exifr.thumbnail(data);
      if (thumbRaw && thumbRaw.length > 0) {
        extraction.embeddedThumbnailPresent = true;
        try {
          const tMeta = await sharp(Buffer.from(thumbRaw)).metadata();
          extraction.embeddedThumbnailWidth = tMeta.width ?? null;
          extraction.embeddedThumbnailHeight = tMeta.height ?? null;
        } catch {
          // Thumbnail buffer unparseable as standalone image; leave dimensions null
        }
      }
    } catch {
      // No embedded thumbnail present
    }
  } catch (err) {
    const errName = err instanceof Error ? err.name : 'Error';
    extraction.parseErrors.push(`Metadata parsing failed: ${errName}`);
  }

  if (extraction.exifPresent) {
    const fieldValues: Record<(typeof EXPECTED_WHEN_EXIF_PRESENT)[number], unknown> = {
      camera_make: extraction.cameraMake,
      camera_model: extraction.cameraModel,
      capture_datetime: extraction.captureDatetime,
      software: extraction.software,
      orientation: extraction.orientation,
    };
    for (const expected of EXPECTED_WHEN_EXIF_PRESENT) {
      if (fieldValues[expected] === null && !extraction.fieldsFound.includes(expected)) {
        extraction.fieldsMissing.push(expected);
      }
    }
  }

  extraction.consistencyChecks = buildConsistencyChecks(
    extraction,
    options.decodedWidth,
    options.decodedHeight,
    options.containerNotes,
  );

  return extraction;
}

function interpretMetadata(extraction: MetadataExtraction): string[] {
  const observations: string[] = [];

  if (extraction.parseErrors.length > 0 && !extraction.exifPresent) {
    observations.push('Metadata parsing encountered errors; available metadata may be incomplete.');
    return observations;
  }

  if (!extraction.exifPresent) {
    observations.push('No EXIF metadata was detected.');
    if (Object.keys(extraction.pngTextTags).length > 0) {
      observations.push(
        `PNG textual metadata chunks detected (${Object.keys(extraction.pngTextTags).join(', ')}).`,
      );
    }
    observations.push(
      'Absence of metadata is common after social uploads, messaging, screenshots, exports, or privacy-related processing, and is not evidence of AI generation or manipulation.',
    );
    return observations;
  }

  observations.push('EXIF metadata is present in the image.');

  if (extraction.cameraMake || extraction.cameraModel) {
    observations.push('Camera information is present in the image metadata.');
  } else {
    observations.push('EXIF is present, but camera make/model information was not found.');
  }

  if (extraction.software) {
    observations.push(
      'Software information is recorded in the metadata and may describe capture or processing history.',
    );
  }

  if (extraction.captureDatetime || extraction.digitizedDatetime) {
    observations.push('Date/time metadata fields were found.');
  }

  if (extraction.orientation !== null) {
    observations.push('EXIF orientation information is present.');
  }

  if (extraction.lens) {
    observations.push('Lens information is present in the metadata.');
  }

  if (extraction.gpsPresent) {
    observations.push('GPS metadata is present, but coordinates are withheld for privacy.');
  }

  if (extraction.embeddedThumbnailPresent && extraction.embeddedThumbnailWidth) {
    observations.push(
      `Embedded EXIF thumbnail detected (${extraction.embeddedThumbnailWidth}x${extraction.embeddedThumbnailHeight}).`,
    );
  }

  for (const check of extraction.consistencyChecks) {
    if (check.status === 'inconsistent') {
      observations.push(`Consistency notice [${check.name}]: ${check.observation}`);
    }
  }

  if (extraction.fieldsMissing.length > 0) {
    observations.push('Metadata is incomplete relative to common EXIF fields.');
  }

  if (extraction.parseErrors.length > 0) {
    observations.push('Some metadata fields could not be parsed cleanly; results may be partial.');
  }

  observations.push('Metadata alone does not establish authenticity or prove manipulation.');
  return observations;
}

function metadataLimitations(extraction: MetadataExtraction): string[] {
  const limitations = [
    'Absence of EXIF metadata is not evidence of AI generation or manipulation.',
    'Camera metadata does not establish authenticity.',
    'Software tags alone do not establish that an image was manipulated.',
    'Exact GPS coordinates are withheld by default for privacy.',
    'Metadata can be stripped, edited, or forged independently of pixel content.',
  ];
  if (extraction.formatNotes) {
    limitations.push(extraction.formatNotes);
  }
  return limitations;
}

export async function buildMetadataAnalysis(
  data: Buffer,
  imageFormat: string,
  options: MetadataBuildOptions = {},
): Promise<AnalysisItem> {
  const extraction = await extractMetadata(data, imageFormat, options);

  const status =
    extraction.parseErrors.length > 0 &&
    !extraction.exifPresent &&
    extraction.fieldsFound.length === 0
      ? 'failed'
      : 'completed';

  const inconsistentCount = extraction.consistencyChecks.filter(
    (c) => c.status === 'inconsistent',
  ).length;

  const methodInfo: MethodDocumentation = {
    what_it_measures:
      'Extracts EXIF, TIFF, GPS presence, PNG tEXt chunks, and embedded IFD1 thumbnails; checks timestamp ordering, EXIF-vs-pixel dimensions, and software lineage.',
    assumptions: [
      'Container metadata headers are well-formed EXIF/TIFF or PNG tEXt segments.',
      'System clocks and export tools record metadata accurately when untouched.',
    ],
    limitations: metadataLimitations(extraction),
    parameters: {
      extract_gps_coordinates: false,
      check_embedded_thumbnail: true,
      scan_png_text_chunks: true,
    },
  };

  const details: MetadataDetails = {
    exif_present: extraction.exifPresent,
    camera_make: extraction.cameraMake,
    camera_model: extraction.cameraModel,
    lens: extraction.lens,
    orientation: extraction.orientation,
    capture_datetime: extraction.captureDatetime,
    digitized_datetime: extraction.digitizedDatetime,
    color_space: extraction.colorSpace,
    exif_version: extraction.exifVersion,
    software: extraction.software,
    gps_present: extraction.gpsPresent,
    gps_fields_present: [...extraction.gpsFieldsPresent],
    fields_found: [...extraction.fieldsFound],
    fields_missing: [...extraction.fieldsMissing],
    parse_errors: [...extraction.parseErrors],
    format_notes: extraction.formatNotes,
    embedded_thumbnail_present: extraction.embeddedThumbnailPresent,
    embedded_thumbnail_width: extraction.embeddedThumbnailWidth,
    embedded_thumbnail_height: extraction.embeddedThumbnailHeight,
    exif_image_width: extraction.exifImageWidth,
    exif_image_height: extraction.exifImageHeight,
    png_text_tags: extraction.pngTextTags,
    consistency_checks: extraction.consistencyChecks,
    method_info: methodInfo,
  };

  return {
    name: 'metadata',
    status,
    observations: interpretMetadata(extraction),
    metrics: {
      exif_present: extraction.exifPresent,
      field_count: extraction.fieldsFound.length,
      gps_present: extraction.gpsPresent,
      parse_error_count: extraction.parseErrors.length,
      inconsistent_check_count: inconsistentCount,
      embedded_thumbnail_present: extraction.embeddedThumbnailPresent,
    },
    limitations: metadataLimitations(extraction),
    details,
  };
}
