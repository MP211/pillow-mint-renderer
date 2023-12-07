const THREE       = require( 'three' );
const {  
  GLTFLoader, TextureLoader 
}                 = require( 'node-three-gltf' );
const { 
  createCanvas
}                 = require( 'node-canvas-webgl' );
const fs          = require( 'fs' );
const GIFEncoder  = require( 'gifencoder' );
const {
  isSquareEnough, isPowerOfTwo
}                 = require('./util.js');


class Renderer {
  #camera;
  #renderer;
  #canvas;
  #scene;
  #model;
  #encoder;
  #stream;  
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
      quality:    2,        // 1->10, best->fastest
      optimize:   false,  
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

    this.#log( 'caching animation values' );
    this.#frames        = this.#duration == 0 ? 1 : this.#fps * this.#duration;
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

    this.#log( 'configuring serialization' );
    this.#stream  = fs.createWriteStream( this.#output );
      this.#stream.on( 'finish', () => {
        this.#stream.end();
        this.onComplete( this.#output );
      });
    this.#encoder = new GIFEncoder( w, h );
      this.#encoder.createReadStream().pipe( this.#stream );
      this.#encoder.setRepeat( this.#duration == 0 ? -1 : 0 ); // -1 (don't repeat)
      this.#encoder.setDelay( 30 );
      this.#encoder.setQuality( this.#quality );

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
        const ambo  = new THREE.AmbientLight(0xCFE2F3, 1.5);
        const spot  = new THREE.DirectionalLight(0xFFFFFF, 2.5);
          spot.target.position.set( ...this.model.position );

        this.#scene.add(ambo);
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

  #render() {
    return new Promise( async ( resolve, reject ) => {
      this.#log( 'rendering' );
      this.#encoder.start();
  
      for (let frame = 1; frame <= this.#frames; frame++) {
        this.#model = await this.onAnimationFrame( 
          this.#model, frame, this.#deltaTime * frame, this.#deltaTime, this.#deltaRotation 
          );

        this.#renderer.render( this.#scene, this.#camera );
        this.#encoder.addFrame( this.#canvas.__ctx__ );

        this.#log( `frame ${frame}/${this.#frames}` );
      }

      this.#log( 'compiling' );
      this.#encoder.finish();

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

module.exports = Renderer