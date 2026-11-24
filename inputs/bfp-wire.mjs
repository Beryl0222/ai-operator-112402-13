import {readFileSync} from 'node:fs';
const data = JSON.parse(readFileSync(new URL('./bfp-wire.json', import.meta.url), 'utf8'));
export function blockFpPlane(channel, row) {
  const width=data.shape[2];
  const mantissa=Int8Array.from({length:width},(_,x)=>
    (x+1===width && channel===3) ? -128 : ((Math.imul(channel*1337+row*31+x+1,0x45d9f3b)>>>24)&255)-128);
  if(row===2) {mantissa[0]=-128; mantissa[1]=1;}
  if(row===1 && channel===2) {mantissa[0]=-128; mantissa[1]=1;}
  const exponent=Int8Array.from({length:width/data.sourceBlock},(_,i)=>data.exponent[(channel+row+i)%data.exponent.length]);
  const valid=Uint8Array.from({length:width},(_,i)=>!(channel===3&&i===width-1));
  return {channel,row,mantissa,exponent,valid};
}
export function blockFpOffset(channel) {
  return data.scale[channel%data.scale.length];
}
