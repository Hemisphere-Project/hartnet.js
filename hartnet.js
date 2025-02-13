// Description: Library for hartnet
//

var dgram = require('dgram');
var EventEmitter = require('events');
var jspack = require('jspack').jspack;
const os = require('os');
const Netmask = require('netmask').Netmask;

const prettystream = require('pino-pretty')({}) // https://github.com/pinojs/pino-pretty#options
const pino = require('pino')

const swap16 = (val) => { return ((val & 0xFF) << 8) | ((val >> 8) & 0xFF); };

// Make a list of unique ipv4 address, there broadcast addresse and Netmask from cidr
function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const networkInfo = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces))
      for (const addr of addresses)
          if (addr.family === 'IPv4' && !addr.internal) {
              const info = {
                  ip: addr.address,
                  mac: addr.mac,
                  netmask: new Netmask(addr.cidr)
              };
              if (!networkInfo.find((n) => n.ip === info.ip)) 
                networkInfo.push(info);
          }
  return networkInfo;
}
const INTERFACES = getNetworkInfo();


class hartnet {

  options = {
    oem: 0x2908,  // OEM code hex
    esta: 0x0000, // ESTA code hex
    port: 6454,   // Port listening for incoming data
    sName: 'hartnet-node', // Shortname
    lName: 'hartnet - OpenSource ArtNet Transceiver', // Longname
    poll_interval: 0,       // Interval for sending ArtPoll
    poll_to: '0.0.0.0/0',           // Destination for ArtPoll
    log: {name: 'hartnet', level: 'info'},
  }

  constructor(options = {}) {

    // Parse options
    for (var key in this.options) 
      this.options[key] = options[key] || this.options[key];
    
    // Create Logger
    this.logger = pino(this.options.log, prettystream);
    this.logger.info(`hartnet.js started`)
    this.logger.debug(this.options)
    this.logger.trace(`Interfaces: ${JSON.stringify(INTERFACES, null, 2)}`)

    // error function to call on error to avoid unhandled exeptions e.g. in Node-RED
    this.errFunc = typeof options.errFunc === 'function' ?  options.errFunc : undefined;

    // init artPollReplyCount
    this.artPollReplyCount = 0;
    // Array containing reference to foreign controllers
    this.controllers = [];
    // Array containing reference to foreign node's
    this.nodes = [];
    // Array containing reference to senders
    this.senders = [];
    // Array containing reference to receiver objects
    this.receivers = [];
    // Timestamp of last ArtPollReply send
    this.last_poll_reply = 0;

    // Create listener for incoming data
    if (!Number.isInteger(this.options.port)) this.handleError(new Error('Invalid Port'));
    this.listener4 = dgram.createSocket({
      type: 'udp4',
      reuseAddr: true,
    });

    // ToDo: IPv6
    // ToDo: Multicast
    // Catch Socket errors
    this.listener4.on('error', function (err) {
      this.handleError(new Error('Socket error: ', err));
    });

    // Register listening object
    this.listener4.on('message', (msg, rinfo) => {
      this.dataParser(msg, rinfo);
    });

    // Start listening
    this.listener4.bind(this.options.port);
    this.logger.debug('Listening on port ' + this.options.port);

    // Open Socket for sending broadcast data
    this.socket = dgram.createSocket('udp4');
    this.socket.bind(() => {
      this.socket.setBroadcast(true);
      this.socket_ready = true;
    });

    // Prepare Poll destination: broadcast address from poll_to
    let p = new Netmask(this.options.poll_to);
    this.pollTo = p.broadcast;
    if (this.pollTo == null) {
      this.logger.warn('Invalid poll_to address: ' + this.options.poll_to, p);
    }

    // Periodically send ArtPoll to discover devices
    if (this.options.poll_interval > 0 && this.pollTo != null)
      setInterval(() => {
        // discard if last_poll_reply is less than 
        // this.options.poll_interval/2 ms ago  
        // it means someone already polled the network
        if ((new Date().getTime() - this.last_poll_reply) < this.options.poll_interval/2 ){
          this.logger.debug('Skip ArtPoll, last poll reply was less than ' + this.options.poll_interval/2 + ' ms ago');
        }
        else this.ArtPoll()
      }, this.options.poll_interval);

    // Periodically check Controllers
    setInterval(() => {
      if (this.controllers) {
        for (var index = 0; index < this.controllers.length; index++) {
          if ((new Date().getTime() - new Date(this.controllers[index].last_poll).getTime()) > 60000) {
            this.controllers[index].alive = false;
          }
        }
        this.logger.debug('Check controller alive: ' + this.controllers.filter((c) => c.alive).length + ' / ' + this.controllers.length);

        // this.logger.debug('List target ifaces: ')
        // let ifaces = []
        
        // // List sender interfaces
        // this.senders.forEach((s) => {
        //   this.logger.debug('\tSender: ' + JSON.stringify(s.interfaces));
        //   ifaces.concat(s.interfaces)
        // });

        // // List receiver interfaces
        // this.receivers.forEach((r) => {
        //   this.logger.debug('\tReceiver: ' + JSON.stringify(r.interfaces));
        //   ifaces.concat(r.interfaces)
        // });

        // // List merged interfaces
        // this.logger.debug('\tUnique ifaces: ' + JSON.stringify(ifaces));

      }
    }, 10000);

    return this;
  }

  // Parser & receiver
  /**
   * @param {Buffer} msg - Message buffer to parse
   * @param {dgram.RemoteInfo} rinfo - Remote info
   */
  dataParser(msg, rinfo) 
  {
    var logMsg = `-> UDP from ${rinfo.address}:${rinfo.port}`
    if (rinfo.size < 10) {
      this.logger.debug(logMsg, '\t = Payload to short');
      return;
    }
    
    // Check first 8 bytes for the "Art-Net" - String
    if (String(jspack.Unpack('!8s', msg)) !== 'Art-Net\u0000') {
      this.logger.debug(logMsg, '\t = Invalid header');
      return;
    }
    var opcode = parseInt(jspack.Unpack('B', msg, 8), 10);
    opcode += parseInt(jspack.Unpack('B', msg, 9), 10) * 256;
    if (!opcode || opcode === 0) {
      this.logger.debug(logMsg, '\t = Invalid OpCode');
      return;
    }

    switch (opcode) {
      // ArtDmx
      //
      case 0x5000:
        var p_address = parseInt(jspack.Unpack('B', msg, 14), 10);
        let data = null;

        // Loop through all receivers and check if packet is for them
        for(var i in this.receivers) 
          if (this.receivers[i].acceptPacket(p_address, rinfo)) 
          {
            this.logger.trace('----')
            this.logger.debug('-> ArtDMX frame received ('+ rinfo.address +') / addr: ' + p_address + ' / len: ' + (msg.length - 18));
            
            // parse data (if not already done)
            if (data == null) {
              data = [];
              for (var ch = 1; ch <= msg.length - 18; ch++) 
                data.push(msg.readUInt8(ch + 17, true));
            } 

            this.logger.trace('\t = Data: ' + data);

            // Transmit data to receiver
            this.receivers[i].receive(data);
          }

        // No receiver found
        if (data == null) {
          this.logger.trace('----')
          this.logger.trace('-> ArtDMX frame received from '+ rinfo.address +' / addr: ' + p_address + ' / len: ' + (msg.length - 18));
          this.logger.trace('\t = no receiver set for this');
        }
        break;
      
      // ArtPoll
      //
      case 0x2000:
        
        // Check for minimum size
        if (rinfo.size < 14) {
          this.logger.debug(logMsg, '\t = ArtPoll too small');
          return;
        }

        // Parse Protocol version
        var proto = parseInt(jspack.Unpack('B', msg, 10), 10);
        proto += parseInt(jspack.Unpack('B', msg, 11), 10) * 256;
        if (!proto || proto < 14) {
          this.logger.debug(logMsg, '\t = invalid OpCode');
          return;
        }
        this.logger.debug('-> ArtPoll received from ' + rinfo.address + ' / Proto: ' + proto);

        // Parse TalkToMe
        var ttm_raw = parseInt(jspack.Unpack('B', msg, 12), 10);

        // Make controller object
        var ctrl = {
          ip: rinfo.address,
          family: rinfo.family,
          last_poll: Date(),
          alive: true,
          diagnostic_unicast: ((ttm_raw & 0b00001000) > 0),
          diagnostic_enable: ((ttm_raw & 0b00000100) > 0),
          unilateral: ((ttm_raw & 0b00000010) > 0),
          priority: parseInt(jspack.Unpack('B', msg, 13), 10)
        };

        // Add or update controller
        var key = this.controllers.findIndex((c) => c.ip === rinfo.address);
        if (key >= 0) this.controllers[key] = ctrl;
        else {
          this.controllers.push(ctrl);
          this.logger.debug('New Controller detected: ' + rinfo.address);
        }

        // Send ArtPollReply
        this.ArtPollReply();
        break;
      
      // ArtPollReply
      //
      case 0x2100:
        this.logger.debug('-> ArtPollReply');

        // Check for minimum size
        if (rinfo.size < 239) {
          this.logger.debug(logMsg, '\t = ArtPollReply too small');
          return;
        }
        
        break;

      // N.C.
      //
      default:
        this.logger.debug(logMsg, '\t = OpCode not implemented');
    }
  }

  /**
   * function to handle the errors an throw them or lead to errFunc
   *
   * @param {object} err - The error to handle
   */
  handleError(err) {
    if (typeof this.errFunc === 'function') {
      // give the error to the function and back to the parent object
      this.errFunc(err);
    } else {
      // if none, trow as before
      throw err;
    }
  }

  /**
   * Returns a new sender instance
   *
   * @param {object} options - Options for the new sender
   * @returns {Sender} - Instance of Sender
   */
  newSender(options) {
    var s = new Sender(options, this);
    this.senders.push(s);
    // if (this.timeoutReply) clearTimeout(this.timeoutReply);
    // this.timeoutReply = setTimeout(() => {
    //   this.ArtPollReply();
    // }, 2000);
    return s;
  }

  /**
   * Returns a new receiver instance
   *
   * @param {object} options - Options for the new receiver
   * @returns {Receiver} - Instance of Receiver
   */
  newReceiver(options) {
    var r = new Receiver(options, this);
    this.receivers.push(r);
    // if (this.timeoutReply) clearTimeout(this.timeoutReply);
    // this.timeoutReply = setTimeout(() => {
    //   this.ArtPollReply();
    // }, 2000);
    return r;
  }

  /**
   * Builds and sends an ArtPoll-Packet
   */
  ArtPoll() {
    if (!this.socket_ready) return;

    // ArtPoll packet format: ID Int8[8], OpCode Int16 0x2000 (conv. to 0x0020), ProtVer Int16, TalkToMe Int8, Priority Int8
    const ArtPollFormat = '!7sBHHBB';
    const ArtPollPacket = Buffer.from(jspack.Pack(
      ArtPollFormat,
      ['Art-Net', 0, 0x0020, 14, 0, 0]
    ));

    this.logger.trace('ArtPoll packet content: ' + ArtPollPacket.toString('hex'));

    // Send UDP
    this.socket.send(ArtPollPacket, 0, ArtPollPacket.length, this.options.port, this.pollTo, (err) => {
      if (err) this.handleError(err);
      this.logger.debug('<- ArtPoll packet sent to ' + this.pollTo + ':' + this.options.port);
    });
  }

  /**
   * Builds and sends an ArtPollReply-Packet
   */
  ArtPollReply() {
    const ArtPollReplyFormat = '!7sBHBBBBHHBBHBBH18s64s64sH4B4B4B4B4B3HB6B4BBB';
    const stateString = '#0001 [' + ('000' + this.artPollReplyCount).slice(-4) + '] hartnet ArtNet-Transceiver running';
    
    const createPacket = (iface, devices) => {
      const basePacket = [
        'Art-Net', 0, 0x0021,
        ...iface.ip.split('.').map(i => parseInt(i)),
        this.options.port,
        0x0001, 0, 0, this.options.oem,
        0, 0b11010000, swap16(this.options.esta),
        this.options.sName.substring(0, 16), this.options.lName.substring(0, 63), stateString,
        devices.length, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0x01,
        ...iface.mac.split(':').map(i => parseInt(i, 16)),
        ...iface.ip.split('.').map(i => parseInt(i)),
        1, 0b00001110,
      ];
  
      basePacket[10] = devices[0].options.net;
      basePacket[11] = devices[0].options.subnet;
  
      let portTypes = 0;
      let goodInput = 0;
      let goodOutput = 0;
      let swIn = 0;
      let swOut = 0;
  
      devices.forEach((device, index) => {
        const isSender = device instanceof Sender;
        portTypes |= (isSender ? 0b01000000 : 0b10000000) << index;
        goodOutput |= (isSender ? 0b10000000 : 0) << index;
        goodInput |= (!isSender ? 0b10000000 : 0) << index;
        if (isSender) {
          swOut |= device.universe << (index * 8);
        } else {
          swIn |= device.universe << (index * 8);
        }
      });
  
      basePacket[18] = portTypes;
      basePacket[22] = goodOutput;
      basePacket[26] = goodInput;
      basePacket[30] = swOut & 0xFF;
      basePacket[31] = (swOut >> 8) & 0xFF;
      basePacket[32] = (swOut >> 16) & 0xFF;
      basePacket[33] = (swOut >> 24) & 0xFF;
      basePacket[34] = swIn & 0xFF;
      basePacket[35] = (swIn >> 8) & 0xFF;
      basePacket[36] = (swIn >> 16) & 0xFF;
      basePacket[37] = (swIn >> 24) & 0xFF;
  
      return Buffer.from(jspack.Pack(ArtPollReplyFormat, basePacket));
    };
  
    // Group devices by interface, net, and subnet
    const groupedDevices = new Map();
    [...this.senders, ...this.receivers].forEach(device => {
      device.interfaces.forEach(iface => {
        const key = `${iface.ip}-${device.options.net}-${device.options.subnet}`;
        if (!groupedDevices.has(key)) {
          groupedDevices.set(key, { iface, net: device.options.net, subnet: device.options.subnet, devices: [] });
        }
        groupedDevices.get(key).devices.push(device);
      });
    });
  
    // Send one packet for each group
    for (const { iface, net, subnet, devices } of groupedDevices.values()) {
      const broadcastip = iface.netmask.broadcast;
      const udppacket = createPacket(iface, devices);
      this.socket.send(udppacket, 0, udppacket.length, 6454, broadcastip, (err) => {
        if (err) this.handleError(err);
        this.logger.debug(`<- ArtPollReply (${devices.length} devices, Net: ${net}, Subnet: ${subnet}) to ${broadcastip}`);
      });
    }
  
    this.artPollReplyCount = (this.artPollReplyCount + 1) % 10000;
    this.last_poll_reply = new Date().getTime();
  }
}

/**
 * Class representing a sender
 */
class Sender {
  
  options = {
    net: 0,
    subnet: 0,
    universe: 0,
    to: '255.255.255.255',
    broadcast: false,
    port: 6454,
    base_refresh_interval: 1000
  }

  interfaces = []

  constructor(opt, parent) 
  {
    this.parent = parent;

    // set options
    for (var key in this.options) 
      this.options[key] = opt[key] !== undefined ? opt[key] : this.options[key];

    // Calculate Net/Subnet/Universe
    this.options.subnet += this.options.universe >> 4;
    this.options.universe = this.options.universe & 0x0F;
    this.options.net += this.options.subnet >> 4;
    this.options.subnet = this.options.subnet & 0x0F;
    

    // Build Subnet/Universe/Net Int16
    this.port_subuni =  (this.options.subnet << 4) | this.options.universe;
    this.port_address = (this.options.net << 8) | this.port_subuni;
    if (this.port_address > 32767) {
      this.handleError(new Error('Invalid Port Address: net * subnet * universe must be smaller than 32768'));
    }
    
    // Initialize values
    this.socket_ready = false;
    this.ArtDmxSeq = 1;
    this.values = new Array(512).fill(0);

    // Find IP destination
    // Get corresponding interfaces
    if (this.options.to === '255.255.255.255') {
      this.ip4 = this.options.to
      this.options.broadcast = true;
      this.interfaces = INTERFACES.slice();
    }
    else {
      for(var iface of INTERFACES) {
  
        if (iface.netmask.contains(this.options.to)) {
          if (this.options.to == iface.netmask.broadcast) this.options.broadcast = true;
          if (this.options.broadcast && iface.netmask.broadcast) this.ip4 = iface.netmask.broadcast;
          else this.ip4 = this.options.to;
          this.interfaces.push(iface);
        }
      }
    }

    // If no interface found, throw warning
    if (this.interfaces.length < 1) {
      this.parent.logger.warn('Sender: No matching interface found for '+this.options.to);
    }
    
    // Create Socket
    this.socket = dgram.createSocket('udp4');
    
    // Check IP and Broadcast
    this.socket.bind(() => {
        this.socket.setBroadcast( this.options.broadcast );
        this.socket_ready = true;
      });

    // Start sending
    this.parent.logger.trace('SENDER started with params: '+JSON.stringify(this.options)+' / '+this.port_address);
    
    // Transmit first Frame
    this.transmit();

    // Send Frame every base_refresh_interval ms - even if no channel was changed
    if ( this.options.base_refresh_interval > 0 )
      this.interval = setInterval(() => {
        this.transmit();
      }, this.options.base_refresh_interval);
  }

  /**
   * Transmits the current values
   */
  transmit() {
    if (!this.socket_ready) return

    // Build packet: ID Int8[8], OpCode Int16 0x5000 (conv. to 0x0050),
    // ProtVer Int16, Sequence Int8, PhysicalPort Int8,
    // SubnetUniverseNet Int16, Length Int16
    var udppacket = Buffer.from(jspack.Pack('!7sBHHBBBBH' + '512B',
      ['Art-Net', 0, 0x0050, 14, this.ArtDmxSeq, 0, this.port_subuni, this.options.net, 512].concat(this.values)));
    // Increase Sequence Counter
    this.ArtDmxSeq = (this.ArtDmxSeq + 1) % 256;
      
    this.parent.logger.trace('----');
    this.parent.logger.trace('ArtDMX frame prepared for ' + this.port_address);
    this.parent.logger.trace('Packet content: ' + udppacket.toString('hex'));
    
    // Send UDP
    this.socket.send(udppacket, 0, udppacket.length, this.options.port, this.ip4,
      (err) => {
        if (err) this.parent.handleError(err);
        this.parent.logger.debug('<- ArtDMX frame sent to ' + this.ip4 + ':' + this.options.port);
      });
  }

  /**
   * Sets a single channel to a value and transmits the change
   *
   * @param {number} channel - channel (0-511)
   * @param {number} value - value (0-255)
   */
  setChannel(channel, value) {
    if ((channel > 511) || (channel < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    this.values[channel] = value;
    this.transmit();
  }


  /**
   * Prepares a single channel (without transmitting)
   *
   * @param {number} channel - channel (0-511)
   * @param {number} value - value (0-255)
   */
  prepChannel(channel, value) {
    if ((channel > 511) || (channel < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    this.values[channel] = value;
  }

  /**
   * Fills channel block with a value and transmits the change
   *
   * @param {number} start - start of the block
   * @param {number} stop - end of the block (inclusive)
   * @param {number} value - value
   */
  fillChannels(start, stop, value) {
    if ((start > 511) || (start < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((stop > 511) || (stop < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    for (var i = start; i <= stop; i++) {
      this.values[i] = value;
    }
    this.transmit();
  }

  /**
   * Resets all channels to zero and Transmits
   */
  blackout() {
    this.values.fill(0);
    this.transmit();
  }

  /**
   * Stops the sender and destroys it
   */
  stop() {
    clearInterval(this.interval);
    this.parent.senders = this.parent.senders.filter((value) => value !== this);
    this.socket.close();
  }
}



/**
 *  Object representing a receiver-instance
 */
class Receiver extends EventEmitter {

  options = {
    from: null,
    net: 0,
    subnet: 0,
    universe: 0,
  }

  interfaces = []

  constructor(opt, parent) {
    super();
    // save parent object
    this.parent = parent;

    // set options
    for (var key in this.options) 
      this.options[key] = opt[key] !== undefined ? opt[key] : this.options[key];

    // Calculate Net/Subnet/Universe
    this.options.subnet += this.options.universe >> 4;
    this.options.universe = this.options.universe & 0x0F;
    this.options.net += this.options.subnet >> 4;
    this.options.subnet = this.options.subnet & 0x0F;

    // Build Subnet/Universe/Net Int16
    this.port_subuni =  (this.options.subnet << 4) | this.options.universe;
    this.port_address = (this.options.net << 8) | this.port_subuni;

    if (this.port_address > 32767) {
      this.handleError(new Error('Invalid Port Address: net * subnet * universe must be smaller than 32768'));
    }

    // ip subnet finder
    this.ipnet = new Netmask('0.0.0.0/0');  // default: listen to all IPs
    if (this.options.from != null) {
      if (this.options.from.indexOf('/') < 0) {
        this.options.from += '/32'; // if no subnet mask is given, assume /32 (exact match)
        this.parent.logger.debug('Receiver: No subnet mask given, assuming '+this.options.from+' (exact match)');
      }
      this.ipnet = new Netmask(this.options.from)
    }

    // Matching interfaces
    for(var iface of INTERFACES) 
      if (this.ipnet.contains(iface.ip)) this.interfaces.push(iface);

    // If no interface found, throw warning
    if (this.interfaces.length < 1)
      this.parent.logger.warn('Receiver: No matching interface found for '+this.options.from);

    // Initialize values
    this.values = new Array(512).fill(0);
    
    this.parent.logger.debug(`RECEIVER started: ${JSON.stringify(this.options)}`);
  }

  /**
   * Check if packet this packet is for this receiver
   */
  acceptPacket(p_address, rinfo) {
    return (p_address == this.port_address) && this.ipnet.contains(rinfo.address);
  }

  /**
   * Handles received data
   *
   * @param {Array} data - Data from received ArtDMX
   */
  receive(data) {
    this.values = data;
    this.emit('data', data);
  }
}


// Export hartnet
module.exports = hartnet;
