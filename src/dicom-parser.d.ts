// Minimal typings for the parts of dicom-parser we use (the package ships no types).
declare module 'dicom-parser' {
  export interface Fragment {
    offset: number;
    position: number;
    length: number;
  }
  export interface Element {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    encapsulatedPixelData?: boolean;
    basicOffsetTable?: number[];
    fragments?: Fragment[];
  }
  export interface DataSet {
    byteArray: Uint8Array;
    elements: Record<string, Element>;
    string(tag: string, index?: number): string | undefined;
    uint16(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    intString(tag: string, index?: number): number | undefined;
  }
  export function parseDicom(byteArray: Uint8Array, options?: unknown): DataSet;
  export function readEncapsulatedImageFrame(
    dataSet: DataSet, pixelDataElement: Element, frameIndex: number,
    basicOffsetTable?: number[], fragments?: Fragment[],
  ): Uint8Array;
  export function readEncapsulatedPixelDataFromFragments(
    dataSet: DataSet, pixelDataElement: Element, startFragmentIndex: number,
    numFragments?: number, fragments?: Fragment[],
  ): Uint8Array;
  export function createJPEGBasicOffsetTable(dataSet: DataSet, pixelDataElement: Element, fragments?: Fragment[]): number[];
}
