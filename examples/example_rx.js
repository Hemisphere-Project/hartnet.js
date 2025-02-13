// Load hartnet as libary
var hartnet = require('../hartnet.js');

// Create new hartnet instance
var hub = new hartnet({
  log: {
    name: "hartnet-rx",
    level: "debug"
  }
});

// Create a new receiver instance, listening for universe 0 on net 0 subnet 0
var receiver = hub.newReceiver({
  from: '10.2.0.0/16',
  universe: 0,
  subnet: 0,
  net: 0,
});

// Dump data if DMX Data is received
receiver.on('data', function(data) {
  // console.log('DMX data:', data);
});
