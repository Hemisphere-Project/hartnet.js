# hartnet.js

hartnet.js is an ArtNet-DMX sender and receiver for nodejs
hartnet.js is forked from [dmxnet](https://github.com/margau/dmxnet).

## Features

- Send DMX-Data as ArtNet
- Use multiple senders with different Net, Subnet and Universe-Settings
- Receive ArtNet-Data
- Use multiple receivers with different Net, Subnet and Universe
- Receive ArtPoll and send ArtPollReply


## Installation

**How to install current development version:**

```bash
npm install git+https://git@github.com/Hemisphere-Project/hartnet.js
```

## Usage

**See examples**

**Include hartnet.js lib:**

```javascript
var hartnet=require('hartnet');
```

**Create new hartnet object:**

```javascript
var hub = new hartnet(options);
```

Options:

```javascript
{
  oem: 0,                     // OEM Code from artisticlicense, default to hartnet OEM.
  esta: 0,                    // ESTA Manufacturer ID from https://tsp.esta.org, default to ESTA/PLASA (0x0000)
  sName: "hartnet-node",      // 17 char long node description, default to "hartnet-node"
  lName: "Long description",  // 63 char long node description, default to "hartnet - OpenSource ArtNet Transceiver"
  port: 6454,                 // UDP Port, default 6454
  poll_interval: 0,           // ArtPoll send interval (ms), default 0 (=disabled)
  poll_to: '0.0.0.0/0'        // ArtPoll ip domain in CIDR format, default 0.0.0.0/0 (all)
  log: {name: 'hartnet', level: 'info'} // Logging Options, see https://github.com/pinojs/pino-pretty#options
}
```

### Structure
hartnet works with objects:
You can create a new Sender or Receiver-instance at any time,
each transmitting or receiving data for a single ArtNet-Universe.

Each combination of net, subnet and universe is possible.

### Notes
hartnet can propagate max. 255 Sender/Receiver-Objects to other nodes.
This is a limitation based on the internal structure of ArtPollReply-Packages.
**You can of course use more Sender/Receiver-Objects, but they won't propagate
trough ArtPoll.**

### Transmitting Art-Net

**Create new sender object:**

```javascript
var sender=hub.newSender(options);
```

Options:

```javascript
{
  to: "255.255.255.255",  // IP to send to, can be broadcast or unicast, default 255.255.255.255
  broadcast: false,       // autodetected from 'to' ip, default false (=autodetect)
                          // If forced to true, will try to replace 'to' with corresponding domain broadcast ip
  universe: 0,            // Destination universe, default 0
  subnet: 0,              // Destination subnet, default 0
  net: 0,                 // Destination net, default 0
  port: 6454,             // Destination UDP Port, default 6454
  base_refresh_interval: 1000 // Default interval for sending unchanged ArtDmx (ms), default 1000
}
```

**Set Channel:**

```javascript
sender.setChannel(channel,value);
```

Sets *channel* (0-511) to *value* (0-255) and transmits the changed values .

**Fill Channels**

```javascript
sender.fillChannels(min,max,value);
```

Sets all channels between *min* and *max* (including these) to *value* and transmits the values.

**Prepare Channel:**

```javascript
sender.prepChannel(channel,value);
```

Prepares *channel* (0-511) to *value* (0-255) without transmitting.

Change is transmitted with next
```javascript
sender.transmit();
```
call, or the next periodically transmit. Useful for changing lots of channels at once/in parallel from device view.

**Transmit:**

```javascript
sender.transmit();
```

Transmits a new ArtDMX Frame manually.

**Reset:**

```javascript
sender.reset();
```

Resets all channels of this sender object to zero.

**Please Note: hartnet.js transmits a dmx-frame every 1000ms even if no channel has changed its value!**

### Receiving Art-Net

**Create a new receiver-instance:**

```javascript
var receiver=hub.newReceiver(options);
```

Options:

```javascript
{
  from: '0.0.0.0/0',  // Filters from, use CIDR notation, default 0.0.0.0/0 (all)
  universe: 0,        // Destination universe, default 0
  subnet: 0,          // Destination subnet, default 0
  net: 0,             // Destination net, default 0
}
```

**Wait for a new frame:**

```javascript
receiver.on('data', function(data) {
  console.log('DMX data:', data);
});
```

The receiver is emits a "data" event each time new values have arrived.

The current values are stored inside the `receiver.values` array for polling.

## ToDo:

- Act as Controller (Sending ArtPoll, Receiving ArtPollReply)
- Maybe support sACN?


### Please feel free to contribute!



## Credits

**Art-Net™ Designed by and Copyright Artistic Licence Holdings Ltd**
