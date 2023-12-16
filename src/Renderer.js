const THREE       = require( 'three' );
const {  
  GLTFLoader, TextureLoader 
}                 = require( 'node-three-gltf' );
const { 
  createCanvas
}                 = require( 'node-canvas-webgl' );
const fs          = require( 'fs' );
const { 
  GIFEncoder, quantize, applyPalette 
}                 = require( 'gifenc' );
const {
  isSquareEnough, isPowerOfTwo, dither
}                 = require( './util.js' );

class Renderer {
  #camera;
  #renderer;
  #canvas;
  #scene;
  #model;
  #frames;
  #deltaRotation; // 360d (radians)
  #deltaTime;
  #verbose;
  #sources;
  #output;
  #w;
  #h;
  #fps;
  #duration;
  #mesh;
  #optimize;
  #quality;
  #color;
  #background;
  #dither;
  #thumbnail;

  #NON_SQUARE_VS = `
  varying vec2 v_uv;
  void main() {
    v_uv        = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  `;
  #NON_SQUARE_FS = `
  uniform sampler2D u_fg;
  uniform float     u_sf;
  varying vec2      v_uv;
  void main() {
    // center, scale
    vec2 center  = vec2(0.5, 0.5);
    vec2 uv      = vec2(center.x + (v_uv.x - center.x) * u_sf, center.y - (v_uv.y - center.y) * u_sf);
    gl_FragColor = texture2D(u_fg, uv);
  }
  `;

  // implementation hooks
  onSetup           = () => Promise.resolve();
  onAnimationFrame  = ( model, frame, time, dTime, dRotation ) => {
    return Promise.resolve( model );
  }
  onComplete        = ( path ) => {};

  constructor( meshAssetPath, outputAssetPath, textureSources, h, w, options = {} ) {

    const opts = Object.assign({
      color:      0x000000, // pillow base color
      fps:        30, 
      duration:   0,        // animation, seconds
      verbose:    false,
      quality:    'rgb565', // rgb565 (best, slower) rgb444 (faster) rgb4444 (faster w/ alpha)
      optimize:   false,
      dither:     true,
      thumbnail:  true,
      },
      options
    );
    
    this.#quality     = opts.quality;
    this.#verbose     = opts.verbose;
    this.#sources     = textureSources || {};
    this.#output      = outputAssetPath;
    this.#mesh        = meshAssetPath;
    this.#h           = h;
    this.#w           = w;
    this.#fps         = opts.fps;
    this.#duration    = opts.duration; 
    this.#optimize    = opts.optimize;
    this.#color       = opts.color;
    this.#background  = new THREE.Color( 0x111111 );
    this.#dither      = opts.dither;
    this.#thumbnail   = opts.thumbnail;

    this.#log( 'caching animation values' );
    this.#frames        = this.#duration == 0 ? 1 : Math.ceil( this.#fps * this.#duration );
    this.#deltaRotation = ( 360 / this.#frames ) * ( Math.PI / 180 ); 
    this.#deltaTime     = ( 1 / this.#fps ) * 1000;

    this.#log( 'instancing graph elements' );
    this.#canvas    = createCanvas( w, h, { alpha: true } );
    this.#renderer  = new THREE.WebGLRenderer({ canvas: this.#canvas, antialias: true });
      this.#renderer.setPixelRatio( 1 );
      this.#renderer.setSize( w, h );
    this.#scene     = new THREE.Scene();
      this.#scene.background = this.#background;
    this.#camera    = new THREE.PerspectiveCamera( 60, w / h, 0.1, 1000 );

    this.#log( 'ready' );
  }

  set optimize(v) {
    this.#optimize = v;
  }
  set camera(v) {
    this.#camera = v;
  }
  get camera() {
    return this.#camera;
  }
  get scene() {
    return this.#scene;
  }
  get model() {
    return this.#model;
  }
  set verbose(v) {
    this.#verbose = v;
  }
  get verbose() {
    return this.#verbose;
  }
  get output() {
    return this.#output;
  }
  get width() {
    return this.#w;
  }
  get height() {
    return this.#h;
  } 
  get fps() {
    return this.#fps;
  }
  get duration() {
    return this.#duration;
  }
  get quality() {
    return this.#quality;
  }
  get color() {
    return this.#color;
  }
  set background(v) {
    this.#background = v;
  }
  get background() {
    return this.#background;
  }
  set dither(v) {
    this.#dither = v;
  }
  get dither() {
    return this.#dither;
  }
  set thumbnail(v) {
    this.#thumbnail = v;
  }
  get thumbnail() {
    return this.#thumbnail;
  }  

  purge() {
    // (remove all lights)
    this.#scene.children.forEach((c) => {
      if ( c.name == 'Light' )
        this.#scene.remove( c );
    })
  }

  start() {
    this.#load( this.#mesh )
      .then( async () => { 
        this.#log( 'creating default lights' );
        const hemi  = new THREE.HemisphereLight( 0xffffff, 0xffffff, 1.75 ); 
          hemi.position.set( 0.0, 1.75, 0.0 )
        const spot  = new THREE.DirectionalLight( 0xFFFFFF, 1.1 );
          spot.target.position.set( ...this.model.position );

        this.#scene.add(hemi);
        this.#scene.add(spot);
        this.#scene.add(spot.target);

        this.#log( 'setup' );
        ( await this.onSetup() );

        this.#scene.add( this.#model );
      })
      .then( async () => {
        if ( Object.keys( this.#sources ).length === 0 )
          return Promise.resolve(); 

        ( await this.#texture() );
      })
      .then( async () => { 
        ( await this.#render() );
      })
      .catch( console.log );
  }

  #log( ...messages ) {
    if ( this.#verbose === true )
      console.log( ...messages );
  }

  async #texture() {
    this.#log( 'texturing' );
    if ( this.#optimize === true ) {
      // auto-detect reused tex uris and substitute with refs
      Object.keys( this.#sources ).reduce(( o, mat ) => {
        const uri = this.#sources[ mat ];
        if ( Object.keys(o).includes( uri ) ) {
          this.#sources[ mat ] = `ref:${o[ uri ]}`;
        } else {
          o[ uri ] = mat;
        }
        return o;
      }, 
      {});
    }

    // prep load of material name -> texture uri sources
    const loaders = Object.keys( this.#sources ).reduce( 
      ( a, mat ) => {
        a.push( 
          new Promise(( resolve, reject ) => {
            let uri = this.#sources[ mat ].trim();
            this.#log( `material ${mat} -> ${uri}` );

            // persist refs or load unique
            if ( this.#optimize === true && uri.startsWith('ref:') ) {
              resolve({ 'mat': mat, 'tex': uri });
            } else {
              ( new TextureLoader() ).load( uri, ( t ) => {
                if ( isSquareEnough( t.image.width, t.image.height, (v) => v > 0.9 ) ) {
                  resolve({ 'mat': mat, 'tex': t });
                } else {
                  const t2 = this.#composite( t );
                  
                  resolve({ 'mat': mat, 'tex': t2 });
                }
              },
              null,   // (progress not currently supported)
              reject
              );
            }
          })
        );
        return a;
      }, 
      []
    );

    // load and reduce to single material name -> texture lookup
    const textures = ( await Promise.all( loaders ) ).reduce( 
      ( o, map ) => {
        let tex = map['tex'];
        // follow refs to previously loaded mats when applicable
        if ( this.#optimize === true && !( tex !== null && typeof tex === 'object' ) ) {
          tex = o[ tex.replace(/^(ref:)(\w+)/gm, "$2") ];
        }
        o[ map['mat'] ] = tex;
        return o;
      }, 
      {} 
    );

    let n = Object.keys( textures ).length;
    if ( n === 0 )
      return Promise.resolve();

    return new Promise(( resolve, reject ) => {
      this.#model.traverse(child => {
        if ( child.material != undefined ) {
          const t = ( child.material.name in textures ) ? 
            textures[ child.material.name ] : null;
          if ( t ) {
            t.flipY           = false;
            t.colorSpace      = THREE.SRGBColorSpace;
            t.generateMipmaps = true;
            if ( !isPowerOfTwo(t.image.height) || !isPowerOfTwo(t.image.width) ) {
              t.minFilter = THREE.LinearFilter;
            }
            child.material.map = t;
            n--;
          }
        }
      });

      if ( n == 0 )
        resolve();
      else 
        reject( `${n} textures not applied` );
    })
  }

  #getPalette() {
    const sample = ( numColors, v3Rotation = null, v3Position = null ) => {
      const oR = this.#model.rotation;
      const oP = this.#model.position;

      if ( v3Rotation )
        this.#model.rotation.set( v3Rotation.x, v3Rotation.y, v3Rotation.z );
      if ( v3Position )
        this.#model.position.set( v3Position.x, v3Position.y, v3Position.z );

      this.#renderer.render( this.#scene, this.#camera );

      const { data }  = this.#canvas.__ctx__.getImageData( 0, 0, this.#w, this.#h );
      const palette   = quantize( data, numColors, { format: this.#quality } );

      // (revert)
      if ( v3Rotation )
        this.#model.rotation.set( oR.x, oR.y, oR.z ); 
      if ( v3Position )
        this.#model.position.set( oP.x, oP.y, oP.z );

      return palette;
    };

    // color counts per face based on dither enabled; values are arbitrary
    const fC = this.#dither ? 32  : 192;
    const bC = this.#dither ? 16   : 64;

    // sample at origin then at y+180, merge as a global palette (combined max 256)
    const fP = sample( fC );
    const bP = sample( bC, new THREE.Vector3( 
      0, this.#model.rotation.y + ( 180 * Math.PI/180 ), 0 
      ) );

    // control (larger) & test (smaller) palettes
    const cP = ( fP.length >= bP.length ? fP : bP );
    const tP = ( fP.length <  bP.length ? fP : bP );
    // lookup
    const tb = cP.reduce(( o, v ) => {
      o[ v.join( '-' ) ] = v;
      return o;
    }, {});
    // concat, no dupe
    tP.forEach(( v ) => {
      const k = v.join( '-' );
      if ( !(k in tb) )
        tb[ k ] = v;
    });

    return Object.values( tb );
  }

  async #snapshot( palette, v3Rotation = null, v3Position = null ) {
    const path = this.output.split('/');
    const file = path.pop();
    const name = file.split('.');
      path.push( `${name.shift()}-t.${name.pop()}` );

    return new Promise( ( resolve, reject ) => {
      const oR = this.#model.rotation;
      const oP = this.#model.position;

      if ( v3Rotation )
        this.#model.rotation.set( v3Rotation.x, v3Rotation.y, v3Rotation.z );
      if ( v3Position )
        this.#model.position.set( v3Position.x, v3Position.y, v3Position.z );

      this.#renderer.render( this.#scene, this.#camera );

      const encoder = new GIFEncoder();
      
      this.#encode( encoder, palette );
        
      encoder.finish();
      
      fs.writeFileSync( path.join( '/' ), encoder.bytes() );

      if ( v3Rotation )
        this.#model.rotation.set( oR.x, oR.y, oR.z ); 
      if ( v3Position )
        this.#model.position.set( oP.x, oP.y, oP.z );
      
      resolve();
    });
  }

  #encode( encoder, palette ) {
    const { 
      data, width, height 
    } = this.#canvas.__ctx__.getImageData( 0, 0, this.#w, this.#h );

    const pass  = this.#dither ? dither( data, width, height, palette ) : data;
    const index = applyPalette( pass, palette );
    
    encoder.writeFrame( 
      index, width, height, { palette, repeat: 0, delay: this.#deltaTime }
      );

    return encoder;
  }

  #render() {
    return new Promise( async ( resolve, reject ) => {
      this.#log( 'rendering' );

      if ( this.#verbose === true )
        console.time( 'elapsed' );

      this.#log( 'building palette' );
      const palette = this.#getPalette();

      if ( this.#thumbnail ) {
        this.#log( 'saving snapshot' );
        ( await this.#snapshot( 
            palette, new THREE.Vector3( 0, this.#model.rotation.y + ( 180 * Math.PI/180 ), 0 ) 
          ) );
      }

      const encoder = new GIFEncoder();

      for (let frame = 0; frame < this.#frames; frame++) {
        this.#renderer.render( this.#scene, this.#camera );
        
        this.#log( `${this.#dither ? 'dithering' : 'sampling'} frame ${frame + 1}/${this.#frames}` );
        this.#encode( encoder, palette );
        
        this.#model = await this.onAnimationFrame( 
          this.#model, frame, this.#deltaTime * frame, this.#deltaTime, this.#deltaRotation 
          );
      }
      this.#log( 'finishing up' );
      
      encoder.finish();

      fs.writeFileSync( this.#output, encoder.bytes() );

      this.onComplete( this.#output );

      if ( this.#verbose === true )
        console.timeEnd( 'elapsed' );

      resolve();
    });
  }

  async #load( meshAssetPath ) {
    this.#log( 'loading' );
    return new Promise(( resolve, reject ) => {
      ( new GLTFLoader() ).load( meshAssetPath, 
        (gltf) => {
          this.#model = gltf.scene;
          resolve();
        }, 
        null, 
        (e) => {
          reject(e);
        }
      );
    });
  }

  #composite( t ) {
    this.#log( `compositing non-square target` );
    t.minFilter = THREE.LinearFilter;
    
    // derive scale factor and wh ratios
    const tW  = t.image.width;
    const tH  = t.image.height;
    const mL  = Math.max( tW, tH );
    const wR  = Math.min( mL, tW ) / Math.max( mL, tW );
    const hR  = Math.min( mL, tH ) / Math.max( mL, tH );
    const sF  = 1.0 / Math.max( wR, hR );

    // shader to comp to size and position
    const sM = new THREE.ShaderMaterial({
      uniforms: {
        u_fg: { value: t  },
        u_sf: { value: sF }
      },
      vertexShader:   this.#NON_SQUARE_VS,
      fragmentShader: this.#NON_SQUARE_FS,
    });

    // render to target and rip texture
    const s2 = new THREE.Scene();
      s2.background = new THREE.Color( this.#color );
    const oC = new THREE.OrthographicCamera( -1, 1, 1, -1, 0, 1 );
    const rT = new THREE.WebGLRenderTarget( mL, mL );
    const pG = new THREE.PlaneGeometry( 2 * wR, 2 * hR );
    const m2 = new THREE.Mesh( pG, sM );
      s2.add(m2);

    this.#renderer.setRenderTarget( rT );
    this.#renderer.render( s2, oC );
    const t2 = rT.texture;
      pG.dispose();
    this.#renderer.setRenderTarget( null );

    return t2;
  }
}

module.exports = Renderer;