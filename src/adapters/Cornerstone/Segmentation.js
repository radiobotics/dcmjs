import { BitArray } from "../../bitArray.js";

const Segmentation = {
  generateToolState,
  readToolState
};

export default Segmentation;

/**
 *
 * @typedef {Object} BrushData
 * @property {Object} toolState - The cornerstoneTools global toolState.
 * @property {Object[]} segments - The cornerstoneTools segment metadata that corresponds to the
 *                                 seriesInstanceUid.
 */

/**
 * generateToolState - Generates cornerstoneTools brush data, given a stack of
 * imageIds, images and the cornerstoneTools brushData.
 *
 * @param  {object[]} images    An array of the cornerstone image objects.
 * @param  {BrushData} brushData and object containing the brushData.
 * @returns {type}           description
 */
function generateToolState(images, brushData) {
  // NOTE: here be dragons. Currently if a brush has been used and then erased,
  // This will flag up as a segmentation, even though its full of zeros.
  // Fixing this cleanly really requires an update of cornerstoneTools?

  const { toolState, segments } = brushData;

  // Calculate the dimensions of the data cube.
  const image0 = images[0];

  const dims = {
    x: image0.columns,
    y: image0.rows,
    z: images.length
  };

  dims.xy = dims.x * dims.y;
  dims.xyz = dims.xy * dims.z;

  const isMultiframe = image0.imageId.includes("?frame");

  const seg = _createSegFromImages(images, isMultiframe);
  const numSegments = _addMetaDataToSegAndGetSegCount(seg, segments);

  if (!numSegments) {
    throw new Warning("No segments to export!");
  }

  // Create an array of ints as long as the number of
  // Voxels * the number of segments.
  const cToolsPixelData = _parseCornerstoneToolsAndExtractSegs(
    images,
    toolState,
    dims,
    segments,
    numSegments
  );

  const dataSet = seg.dataset;

  // Re-define the PixelData ArrayBuffer to be the correct length
  // => segments * rows * columns * slices / 8 (As 8 bits/byte)
  seg.dataset.PixelData = new ArrayBuffer((numSegments * dims.xyz) / 8);

  const pixelDataUint8View = new Uint8Array(seg.dataset.PixelData);
  const bitPackedcToolsData = BitArray.pack(cToolsPixelData);

  for (let i = 0; i < pixelDataUint8View.length; i++) {
    pixelDataUint8View[i] = bitPackedcToolsData[i];
  }

  const segBlob = dcmjs.data.datasetToBlob(seg.dataset);

  return segBlob;
}

function _parseCornerstoneToolsAndExtractSegs(
  images,
  toolState,
  dims,
  segments,
  numSegments
) {
  const cToolsPixelData = new Uint8ClampedArray(dims.xyz * numSegments);

  let currentSeg = 0;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    if (!segments[segIdx]) {
      continue;
    }

    _extractOneSeg(
      segIdx,
      images,
      toolState,
      cToolsPixelData,
      currentSeg,
      dims
    );

    currentSeg++;
  }

  return cToolsPixelData;
}

function _extractOneSeg(
  segIdx,
  images,
  toolState,
  cToolsPixelData,
  currentSeg,
  dims
) {
  for (let z = 0; z < images.length; z++) {
    const imageId = images[z].imageId;
    const imageIdSpecificToolState = toolState[imageId];

    if (
      imageIdSpecificToolState &&
      imageIdSpecificToolState.brush &&
      imageIdSpecificToolState.brush.data
    ) {
      const pixelData = imageIdSpecificToolState.brush.data[segIdx].pixelData;

      for (let p = 0; p < dims.xy; p++) {
        cToolsPixelData[currentSeg * dims.xyz + z * dims.xy + p] = pixelData[p];
      }
    }
  }
}

function _addMetaDataToSegAndGetSegCount(seg, segments) {
  let numSegments = 0;

  for (let i = 0; i < segments.length; i++) {
    if (segments[i]) {
      numSegments++;

      seg.addSegment(segments[i]);
    }
  }

  return numSegments;
}

/**
 * _createSegFromImages - description
 *
 * @param  {object} images       description
 * @param  {Boolean} isMultiframe description
 * @returns {dataSet}              description
 */
function _createSegFromImages(images, isMultiframe) {
  const datasets = [];

  if (isMultiframe) {
    const image = images[0];
    const arrayBuffer = image.data.byteArray.buffer;

    const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
    const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
      dicomData.dict
    );

    dataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(
      dicomData.meta
    );

    datasets.push(dataset);
  } else {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const arrayBuffer = image.data.byteArray.buffer;
      const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
      const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
        dicomData.dict
      );

      dataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(
        dicomData.meta
      );
      datasets.push(dataset);
    }
  }

  const multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset(datasets);

  return new dcmjs.derivations.Segmentation([multiframe]);
}

function readToolState(imageIds, arrayBuffer) {
  dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
  let dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomData.dict
  );
  dataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(dicomData.meta);
  const multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset([dataset]);

  const dims = {
    x: multiframe.Columns,
    y: multiframe.Rows,
    z: imageIds.length,
    xy: multiframe.Columns * multiframe.Rows,
    xyz: multiframe.Columns * multiframe.Rows * imageIds.length
  };

  const segmentSequence = multiframe.SegmentSequence;
  const pixelData = dcmjs.data.BitArray.unpack(multiframe.PixelData);

  const segMetadata = {
    seriesInstanceUid: multiframe.SeriesInstanceUid,
    data: []
  };

  const toolState = {};

  if (Array.isArray(segmentSequence)) {
    const segCount = segmentSequence.length;

    for (let z = 0; z < imageIds.length; z++) {
      const imageId = imageIds[z];

      const imageIdSpecificToolState = {};

      imageIdSpecificToolState.brush = {};
      imageIdSpecificToolState.brush.data = [];

      const brushData = imageIdSpecificToolState.brush.data;

      for (let i = 0; i < segCount; i++) {
        brushData[i] = {
          invalidated: true,
          pixelData: new Uint8ClampedArray(dims.x * dims.y)
        };
      }

      toolState[imageId] = imageIdSpecificToolState;
    }

    for (let segIdx = 0; segIdx < segmentSequence.length; segIdx++) {
      segMetadata.data.push(segmentSequence[segIdx]);

      for (let z = 0; z < imageIds.length; z++) {
        const imageId = imageIds[z];

        const cToolsPixelData = toolState[imageId].brush.data[segIdx].pixelData;

        for (let p = 0; p < dims.xy; p++) {
          cToolsPixelData[p] = pixelData[segIdx * dims.xyz + z * dims.xy + p];
        }
      }
    }
  } else {
    // Only one segment, will be stored as an object.
    segMetadata.data.push(segmentSequence);

    const segIdx = 0;

    for (let z = 0; z < imageIds.length; z++) {
      const imageId = imageIds[z];

      const imageIdSpecificToolState = {};

      imageIdSpecificToolState.brush = {};
      imageIdSpecificToolState.brush.data = [];
      imageIdSpecificToolState.brush.data[segIdx] = {
        invalidated: true,
        pixelData: new Uint8ClampedArray(dims.x * dims.y)
      };

      const cToolsPixelData =
        imageIdSpecificToolState.brush.data[segIdx].pixelData;

      for (let p = 0; p < dims.xy; p++) {
        cToolsPixelData[p] = pixelData[z * dims.xy + p];
      }

      toolState[imageId] = imageIdSpecificToolState;
    }
  }

  return { toolState, segMetadata };
}
