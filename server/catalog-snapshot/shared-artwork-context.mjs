// Resolve references through canonical artwork bytes, never copied card DTOs.
import {readArtwork} from './artwork-facet-reader.mjs';
export async function readSharedArtwork(context,features){
 if(!Array.isArray(features.ids)||!Array.isArray(features.artworks)||features.ids.length!==features.artworks.length||features.ids.length>500||new Set(features.ids).size!==features.ids.length||features.ids.some((id,i)=>id!==features.artworks[i]?.id))throw Error('Invalid shared artwork references');
 const result=Array(features.ids.length);let cursor=0;await Promise.all(Array.from({length:Math.min(4,features.ids.length)},async()=>{while(cursor<features.ids.length){const i=cursor++,item=await readArtwork(context,features.ids[i]);if(!item||!item.published||!item.indexable)throw Error('Missing canonical shared artwork');result[i]=item}}));return result;
}
