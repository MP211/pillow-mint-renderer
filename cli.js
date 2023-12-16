
// node cli.js -d -f 'https://lh3.googleusercontent.com/2WYIu_QWkFaH19qEC63V8wPX7OTlvIzJ0uQvTTzuZh2tpjIt48PPzQcsXHyF3EAAPaOHErUGg5KoilE9d75ZC7iqL-1JuKmTag=s250' -b 'https://sseance-public.s3.us-west-1.amazonaws.com/back.png'
// node cli.js -d -f 'https://lh3.googleusercontent.com/JkcEkgNGyKnd5HlZYgF9tQB2oVl48Jz1G9gvpVcgxIVxGXB3IsfYP0vnyC8_IHeMOAd-Xe_NgNwBt-ZxyM8fpOQjvK9NVU_JaCE=s250' -b 'https://sseance-public.s3.us-west-1.amazonaws.com/back.png'
// node cli.js -d -f 'https://lh3.googleusercontent.com/gAxNuvzWnZcZXHMIBrCrK-KxK-E2xiXjDDzCH0YVXjyznKtpJuZSNLRdDxXuHKVsmQ_qDrUt3ngAYxjEw2gwZpb6spEuPpL8IHV0=s250' -b 'https://sseance-public.s3.us-west-1.amazonaws.com/back.png'
// node cli.js -d -f 'https://lh3.googleusercontent.com/29nCU6zR51d8dP6HmtvsIp6q94njEDkTuw6OreCr416ozC4cIO3m6RkLksFhl1-Q0xA1j9tdn-jweRMpwPa3Gk3KzOxiTIblsRo=s250' -b 'https://sseance-public.s3.us-west-1.amazonaws.com/back.png'

const { TextureLoader } = require( 'node-three-gltf' );
const commander         = require( 'commander' );
const path              = require( 'path' );
const { v4: uuidv4 }    = require( 'uuid' );
const Renderer          = require( './src/Renderer' );

commander
  .option( '-d, --debug',         'Verbose?'  )
  .option( '-f, --front <path>',  'URI'       )
  .option( '-b, --back <path>',   'URI'       )
  .parse( process.argv );

const options = commander.opts();

const renderer = new Renderer(
  './assets/Pillow_highpoly.gltf', 
  path.resolve( `./output/${uuidv4()}.gif` ),
  {
    'Front':  options.front, 
    'Back':   options.back,
  },
  1024, 1024,
  {
    fps:        15,
    duration:   5,
    quality:    'rgb444',
    verbose:    options.debug,
    color:      0x000000,
    dither:     true,
    thumbnail:  true,
  }
  );
  renderer.onSetup = () => {
    renderer.camera.position.set( 0.0, 0.0, 0.6 );
    renderer.model.rotation.set( 0.0, 0.0, 0.0 );
    renderer.model.position.set( 0.0, -0.2, 0.0 );

    ( new TextureLoader() ).load( './assets/bg-4.png', (t) => {
      renderer.scene.background = t;
    });
    
    return Promise.resolve();
  }
  renderer.onAnimationFrame = ( model, f, t, dt, dr ) => {
    model.rotation.y -= dr;
    
    return Promise.resolve( model );
  };
  renderer.onComplete = ( path ) => {
    console.log( 'complete', path );
  };

renderer.start();
