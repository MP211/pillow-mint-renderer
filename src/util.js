const scaleToRange = ( v, vMin, vMax, rMin = 0, rMax = 1 ) => {
  return (((v - vMin) / (vMax - vMin)) * (rMax - rMin)) + rMin;
};

const isPowerOfTwo = ( x ) => {
  return Math.log2( x ) % 1 === 0;
};

const isSquareEnough = ( w, h, t = (v) => v > 0.5 ) => {
  if ( w === h )
    return true;

  return t( 
    scaleToRange( Math.min( w, h ), 0, Math.max( w, h ) ) 
    );
};

module.exports = {
  scaleToRange, isPowerOfTwo, isSquareEnough
}