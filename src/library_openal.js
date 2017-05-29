//"use strict";

var LibraryOpenAL = {
	// ************************************************************************
	// ** INTERNALS 
	// ************************************************************************

	$AL__deps: ["$Browser"],
	$AL: {
		// ------------------------------------------------------
		// -- Constants 
		// ------------------------------------------------------

		QUEUE_INTERVAL: 25,
		QUEUE_LOOKAHEAD: 100.0 / 1000.0,

		// ------------------------------------------------------
		// -- ALC Fields
		// ------------------------------------------------------

		_alcErr: 0,
		get alcErr() {
			return this._alcErr;
		},
		set alcErr(val) {
			if (this._alcErr === 0 /* ALC_NO_ERROR */) {
				this._alcErr = val;
			}
		},

		alcStringCache: {},

		// ------------------------------------------------------
		// -- AL Fields
		// ------------------------------------------------------

		stringCache: {},
		contexts: [],
		currentCtx: null,
		buffers: [],

		// ------------------------------------------------------
		// -- Mixing Logic
		// ------------------------------------------------------

		scheduleContextAudio: function(context) {
			// If we are animating using the requestAnimationFrame method, then the main loop does not run when in the background.
			// To give a perfect glitch-free audio stop when switching from foreground to background, we need to avoid updating
			// audio altogether when in the background, so detect that case and kill audio buffer streaming if so.
			if (Browser.mainLoop.timingMode === 1/*EM_TIMING_RAF*/ && document["visibilityState"] != "visible") {
				return;
			}

			for (var i in context.sources) {
				AL.scheduleSourceAudio(context.sources[i], AL.QUEUE_LOOKAHEAD);
			}
		},

		scheduleSourceAudio: function(src, lookahead) {
			// See comment on scheduleContextAudio above.
			if (Browser.mainLoop.timingMode === 1/*EM_TIMING_RAF*/ && document["visibilityState"] != "visible") {
				return;
			}

			if (src.state !== 0x1012 /* AL_PLAYING */) {
				return;
			}

			AL.updateSource(src);

			var startTime = src.bufStartTime;
			var startOffset = src.bufOffset;
			var bufCursor = src.bufsProcessed;

			for (var i = 0; i < src.audioQueue.length; i++) {
				var audioSrc = src.audioQueue[i];
				startTime = audioSrc._startTime + audioSrc._duration;
				startOffset = 0.0;
				bufCursor++;
			}

			var lookaheadTime = src.context.audioCtx.currentTime + lookahead;
			while (startTime < lookaheadTime) {
				if (bufCursor >= src.bufQueue.length) {
					if (src.loop) {
						bufCursor %= src.bufQueue.length;
					} else {
						break;
					}
				}

				var buf = src.bufQueue[bufCursor % src.bufQueue.length];
				var duration = (buf.audioBuf.duration - startOffset) / src.playbackRate;

				var audioSrc = src.context.audioCtx.createBufferSource();
				audioSrc._startOffset = startOffset;
				audioSrc._duration = duration;
				audioSrc.buffer = buf.audioBuf;
				audioSrc.connect(src.gain);
				if (src.playbackRate != 1.0) {
					audioSrc.playbackRate.value = src.playbackRate;
				}

				if (typeof(audioSrc.start) !== "undefined") {
					startTime = Math.max(startTime, src.context.audioCtx.currentTime);
					audioSrc.start(startTime, startOffset);
				} else if (typeof(audioSrc.noteOn) !== "undefined") {
					startTime = Math.max(startTime, src.context.audioCtx.currentTime);
					audioSrc.noteOn(startTime);
#if OPENAL_DEBUG
					if (offset > 0.0) {
						Runtime.warnOnce("The current browser does not support AudioBufferSourceNode.start(when, offset); method, so cannot play back audio with an offset "+startOffset+" secs! Audio glitches will occur!");
					}
#endif
				}
#if OPENAL_DEBUG
				else {
					Runtime.warnOnce("Unable to start AudioBufferSourceNode playback! Not supported by the browser?");
				}

				console.log("scheduleSourceAudio() queuing buffer " + buf.id + " for source " + src.id + " at " + startTime + " (offset by " + startOffset + ")");
#endif
				audioSrc._startTime = startTime;
				src.audioQueue.push(audioSrc);

				startTime += duration;
				startOffset = 0.0;
				bufCursor++;
			}
		},

		// Clean up old sourceBuffers.
		updateSource: function(src) {
			if (src.state !== 0x1012 /* AL_PLAYING */) {
				return;
			}

			var currentTime = src.context.audioCtx.currentTime;
			if (!isFinite(src.bufStartTime)) {
				src.bufStartTime = currentTime - src.bufOffset / src.playbackRate;
				src.bufOffset = 0.0;
			}

			var nextStartTime = 0.0;
			while (src.audioQueue.length) {
				var audioSrc = src.audioQueue[0];
				nextStartTime = audioSrc._startTime + audioSrc._duration; // n.b. audioSrc._duration already factors in playbackRate, so no divide by src.playbackRate on it.

				if (currentTime < nextStartTime) {
					break;
				}

				src.audioQueue.shift();
				src.bufStartTime = nextStartTime;
				src.bufOffset = 0.0;
				src.bufsProcessed++;
			}

			var audioSrc = src.audioQueue[0];
			if (audioSrc) {
				src.bufOffset = (currentTime - audioSrc._startTime) * src.playbackRate;
			} else {
				while (true) {
					if (src.bufsProcessed >= src.bufQueue.length) {
						if (src.loop) {
							src.bufsProcessed %= src.bufQueue.length;
						} else {
							AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
							break;
						}
					}
					var buf = src.bufQueue[src.bufsProcessed];
					nextStartTime = src.bufStartTime + buf.audioBuf.duration / src.playbackRate;

					if (currentTime < nextStartTime) {
						src.bufOffset = (currentTime - src.bufStartTime) * src.playbackRate;
						break;
					}

					src.bufStartTime = nextStartTime;
					src.bufOffset = 0.0;
					src.bufsProcessed++;
				}
			}
		},

		cancelPendingSourceAudio: function(src) {
			AL.updateSource(src);

			for (var i = 1; i < src.audioQueue.length; i++) {
				var audioSrc = src.audioQueue[i];
				audioSrc.stop();
			}

			if (src.audioQueue.length) {
				src.audioQueue.length = 1;
			}
		},

		stopSourceAudio: function(src) {
			for (var i = 0; i < src.audioQueue.length; i++) {
				src.audioQueue[i].stop();
			}
			src.audioQueue.length = 0;
		},

		setSourceState: function(src, state) {
			if (state === 0x1012 /* AL_PLAYING */) {
				if (src.state === 0x1013 /* AL_PAUSED */) {
#if OPENAL_DEBUG
					console.log("setSourceState() resuming source " + src.id + " at " + src.bufOffset.toFixed(4));
#endif
				} else {
					src.bufsProcessed = 0;
					src.bufOffset = 0.0;
#if OPENAL_DEBUG
					console.log("setSourceState() resetting and playing source " + src.id);
#endif
				}

				AL.stopSourceAudio(src);

				src.state = 0x1012 /* AL_PLAYING */;
				src.bufStartTime = Number.NEGATIVE_INFINITY;
				AL.scheduleSourceAudio(src);
			} else if (state === 0x1013 /* AL_PAUSED */) {
				if (src.state === 0x1012 /* AL_PLAYING */) {
					// Store off the current offset to restore with on resume.
					AL.updateSource(src);
					AL.stopSourceAudio(src);

					src.state = 0x1013 /* AL_PAUSED */;
#if OPENAL_DEBUG
					console.log("setSourceState() pausing source " + src.id + " at " + src.bufOffset.toFixed(4));
#endif
				}
			} else if (state === 0x1014 /* AL_STOPPED */) {
				if (src.state !== 0x1011 /* AL_INITIAL */) {
					src.state = 0x1014 /* AL_STOPPED */;
					src.bufsProcessed = src.bufQueue.length;
					src.bufStartTime = Number.NEGATIVE_INFINITY;
					src.bufOffset = 0.0;
					AL.stopSourceAudio(src);
#if OPENAL_DEBUG
					console.log("setSourceState() stopping source " + src.id);
#endif
				}
			} else if (state === 0x1011 /* AL_INITIAL */) {
				if (src.state !== 0x1011 /* AL_INITIAL */) {
					src.state = 0x1011 /* AL_INITIAL */;
					src.bufsProcessed = 0;
					src.bufStartTime = Number.NEGATIVE_INFINITY;
					src.bufOffset = 0.0;
					AL.stopSourceAudio(src);
#if OPENAL_DEBUG
					console.log("setSourceState() initializing source " + src.id);
#endif
				}
			}
		},

		// ------------------------------------------------------
		// -- Accessor Helpers
		// ------------------------------------------------------

		getDoubleHelper: function(funcname, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + " called without a valid context");
#endif
				return 0;
			}
			// Right now, none of these can be set, so we directly return
			// the values we support.
			switch (param) {
			case 0xC000 /* AL_DOPPLER_FACTOR */: return 1;
			case 0xC003 /* AL_SPEED_OF_SOUND */: return 343.3;
			case 0xD000 /* AL_DISTANCE_MODEL */: return 0 /* AL_NONE */;
			case 0xC001 /* AL_DOPPLER_VELOCITY */:
				Runtime.warnOnce("Getting the value for AL_DOPPLER_VELOCITY is deprecated as of OpenAL 1.1!");
				return 1;
			}
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0;
		},

		// Helper for getting listener attributes as an array of numbers
		getListenerHelper: function getListenerHelper(funcname, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + " called without a valid context");
#endif
				return null;
			}

			switch (param) {
			case 0x1004 /* AL_POSITION */:
				return AL.currentCtx.audioCtx.listener._position;
			case 0x1006 /* AL_VELOCITY */:
				return AL.currentCtx.audioCtx.listener._velocity;
			case 0x100F /* AL_ORIENTATION */:
				return AL.currentCtx.audioCtx.listener._orientation;
			}

#if OPENAL_DEBUG
			console.error(funcname + " with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return null;
		},

		// For lack of a better name...
		bufferDummyAccessor: function(funcname, bufferId) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + " called without a valid context");
#endif
				return;
			}
			var buf = AL.buffers[bufferId - 1];
			if (!buf) {
#if OPENAL_DEBUG
				console.error(funcname + " called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}

			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
		},

		getSource3Helper: function(funcname, source, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + " called without a valid context");
#endif
				return null;
			}
			var src = AL.currentCtx.src[source];
			if (!src) {
#if OPENAL_DEBUG
				console.error(funcname + " called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return null;
			}
			switch (param) {
			case 0x1004 /* AL_POSITION */: return src.position;
			case 0x1005 /* AL_DIRECTION */: return src.direction;
			case 0x1006 /* AL_VELOCITY */: return src.velocity;
			}
#if OPENAL_DEBUG
			console.error(funcname + " with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
		}
	},

	// ***************************************************************************
	// ** ALC API 
	// ***************************************************************************

	// -------------------------------------------------------
	// -- ALC Resources
	// -------------------------------------------------------

	alcOpenDevice: function(deviceName) {
		if (typeof(AudioContext) !== "undefined" || typeof(webkitAudioContext) !== "undefined") {
			return 1; // non-null pointer -- we just simulate one device
		} else {
			return 0;
		}
	},

	alcCloseDevice: function(device) {
		// Stop playback, etc
	},

	alcCreateContext: function(device, attrList) {
		if (device != 1) {
#if OPENAL_DEBUG
			console.log("alcCreateContext() called with an invalid device");
#endif
			AL.alcErr = 0xA001; /* ALC_INVALID_DEVICE */
			return 0;
		}

		if (attrList) {
#if OPENAL_DEBUG
			console.log("The attrList argument of alcCreateContext is not supported yet");
#endif
			AL.alcErr = 0xA004; /* ALC_INVALID_VALUE */
			return 0;
		}

		var ac;
		try {
			ac = new AudioContext();
		} catch (e) {
			try {
				ac = new webkitAudioContext();
			} catch (e) {}
		}

		if (ac) {
			// Old Web Audio API (e.g. Safari 6.0.5) had an inconsistently named createGainNode function.
			if (typeof(ac.createGain) === "undefined") ac.createGain = ac.createGainNode;

			var gain = ac.createGain();
			gain.connect(ac.destination);
			// Extend the Web Audio API AudioListener object with a few tracking values of our own.
			ac.listener._position = [0.0, 0.0, 0.0];
			ac.listener._velocity = [0.0, 0.0, 0.0];
			ac.listener._orientation = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
			var context = {
				id: AL.contexts.length + 1,
				audioCtx: ac,
				_err: 0,
				get err() {
					return this._err;
				},
				set err(val) {
					if (this._err === 0 /* AL_NO_ERROR */) {
						this._err = val;
					}
				},
				sources: [],
				interval: setInterval(function() { AL.scheduleContextAudio(context); }, AL.QUEUE_INTERVAL),
				gain: gain
			};
			AL.contexts.push(context);
			return context.id;
		} else {
			AL.alcErr = 0xA001; /* ALC_INVALID_DEVICE */
			return 0;
		}
	},

	alcDestroyContext: function(contextId) {
		var ctx = AL.contexts[contextId - 1];
		if (AL.currentCtx === ctx) {
#if OPENAL_DEBUG
			console.log("alcDestroyContext() called with an invalid context");
#endif
			AL.alcErr = 0xA002 /* ALC_INVALID_CONTEXT */;
			return;
		}

		// Stop playback, etc
		clearInterval(AL.contexts[contextId - 1].interval);
		delete AL.contexts[contextId - 1];
	},

	// Might be very interesting to implement that !
	alcCaptureOpenDevice: function(deviceName, freq, format, bufferSize) {
		Runtime.warnOnce("alcCapture*() functions are not supported yet.");
#if OPENAL_DEBUG
		console.error("alcCaptureOpenDevice() is not supported yet");
#endif
		// From the programmer"s guide, ALC_OUT_OF_MEMORY"s meaning is
		// overloaded here, to mean:
		// "The specified device is invalid, or can not capture audio."
		// This may be misleading to API users, but well...
		AL.alcErr = 0xA005 /* ALC_OUT_OF_MEMORY */;
		return 0; // NULL device pointer
	},

	alcCaptureCloseDevice: function(device) {
#if OPENAL_DEBUG
		console.error("alcCaptureCloseDevice() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
		return false;
	},

	// -------------------------------------------------------
	// -- ALC State
	// -------------------------------------------------------

	alcGetError: function(device) {
		var err = AL.alcErr;
		AL.alcErr = 0 /* ALC_NO_ERROR */;
		return err;
	},

	alcGetCurrentContext: function() {
		if (AL.currentCtx !== null) {
			return AL.currentCtx.id;
		} else {
			return 0;
		}
	},

	alcMakeContextCurrent: function(contextId) {
		if (contextId === 0) {
			AL.currentCtx = null;
			return 0;
		} else {
			AL.currentCtx = AL.contexts[contextId - 1];
			return 1;
		}
	},

	alcGetContextsDevice: function(contextId) {
		if (contextId <= AL.contexts.length && contextId > 0) {
			// Returns the only one audio device
			return 1;
		}
		return 0;
	},

	alcProcessContext: function(contextId) {},
	alcSuspendContext: function(contextId) {},

	alcCaptureStart: function(device) {
#if OPENAL_DEBUG
		console.error("alcCaptureStart() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcCaptureStop: function(device) {
#if OPENAL_DEBUG
		console.error("alcCaptureStop() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcCaptureSamples: function(device, buffer, num_samples) {
#if OPENAL_DEBUG
		console.error("alcCaptureSamples() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcIsExtensionPresent: function(device, extName) {
		return 0;
	},

	alcGetProcAddress: function(device, fname) {
		return 0;
	},

	alcGetEnumValue: function(device, name) {
		// Spec says :
		// Using a NULL handle is legal, but only the
		// tokens defined by the AL core are guaranteed.
		if (device !== 0 && device !== 1) {
#if OPENAL_DEBUG
			console.error("alcGetEnumValue() called with an invalid device");
#endif
			// ALC_INVALID_DEVICE is not listed as a possible error state for
			// this function, sadly.
			return 0 /* AL_NONE */;
		} else if (name === 0) {
			AL.alcErr = 0xA004 /* ALC_INVALID_VALUE */;
			return 0; /* AL_NONE */
		}
		name = Pointer_stringify(name);
		// See alGetEnumValue(), but basically behave the same as OpenAL-Soft
		switch(name) {
		case "ALC_NO_ERROR": return 0;
		case "ALC_INVALID_DEVICE": return 0xA001;
		case "ALC_INVALID_CONTEXT": return 0xA002;
		case "ALC_INVALID_ENUM": return 0xA003;
		case "ALC_INVALID_VALUE": return 0xA004;
		case "ALC_OUT_OF_MEMORY": return 0xA005;
		case "ALC_MAJOR_VERSION": return 0x1000;
		case "ALC_MINOR_VERSION": return 0x1001;
		case "ALC_ATTRIBUTES_SIZE": return 0x1002;
		case "ALC_ALL_ATTRIBUTES": return 0x1003;
		case "ALC_DEFAULT_DEVICE_SPECIFIER": return 0x1004;
		case "ALC_DEVICE_SPECIFIER": return 0x1005;
		case "ALC_EXTENSIONS": return 0x1006;
		case "ALC_FREQUENCY": return 0x1007;
		case "ALC_REFRESH": return 0x1008;
		case "ALC_SYNC": return 0x1009;
		case "ALC_MONO_SOURCES": return 0x1010;
		case "ALC_STEREO_SOURCES": return 0x1011;
		case "ALC_CAPTURE_DEVICE_SPECIFIER": return 0x310;
		case "ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER": return 0x311;
		case "ALC_CAPTURE_SAMPLES": return 0x312;
		}
		AL.alcErr = 0xA004 /* ALC_INVALID_VALUE */;
#if OPENAL_DEBUG
		console.error("No value for `" + name + "` is known by alcGetEnumValue()");
#endif
		return 0 /* AL_NONE */;
	},

	alcGetString: function(device, param) {
		if (AL.alcStringCache[param]) return AL.alcStringCache[param];
		var ret;
		switch (param) {
		case 0 /* ALC_NO_ERROR */:
			ret = "No Error";
			break;
		case 0xA001 /* ALC_INVALID_DEVICE */:
			ret = "Invalid Device";
			break;
		case 0xA002 /* ALC_INVALID_CONTEXT */:
			ret = "Invalid Context";
			break;
		case 0xA003 /* ALC_INVALID_ENUM */:
			ret = "Invalid Enum";
			break;
		case 0xA004 /* ALC_INVALID_VALUE */:
			ret = "Invalid Value";
			break;
		case 0xA005 /* ALC_OUT_OF_MEMORY */:
			ret = "Out of Memory";
			break;
		case 0x1004 /* ALC_DEFAULT_DEVICE_SPECIFIER */:
			if (typeof(AudioContext) !== "undefined" ||
					typeof(webkitAudioContext) !== "undefined") {
				ret = "Device";
			} else {
				return 0;
			}
			break;
		case 0x1005 /* ALC_DEVICE_SPECIFIER */:
			if (typeof(AudioContext) !== "undefined" ||
					typeof(webkitAudioContext) !== "undefined") {
				ret = "Device\0";
			} else {
				ret = "\0";
			}
			break;
		case 0x311 /* ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER */:
			return 0;
			break;
		case 0x310 /* ALC_CAPTURE_DEVICE_SPECIFIER */:
			ret = "\0"
			break;
		case 0x1006 /* ALC_EXTENSIONS */:
			if (!device) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			ret = "";
			break;
		default:
			AL.alcErr = 0xA003 /* ALC_INVALID_ENUM */;
			return 0;
		}

		ret = allocate(intArrayFromString(ret), "i8", ALLOC_NORMAL);

		AL.alcStringCache[param] = ret;

		return ret;
	},

	alcGetIntegerv: function(device, param, size, data) {
		if (size === 0 || !data) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch(param) {
		case 0x1000 /* ALC_MAJOR_VERSION */:
			{{{ makeSetValue("data", "0", "1", "i32") }}};
			break;
		case 0x1001 /* ALC_MINOR_VERSION */:
			{{{ makeSetValue("data", "0", "1", "i32") }}};
			break;
		case 0x1002 /* ALC_ATTRIBUTES_SIZE */:
			if (!device) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("data", "0", "1", "i32") }}};
			break;
		case 0x1003 /* ALC_ALL_ATTRIBUTES */:
			if (!device) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("data", "0", "0", "i32") }}};
			break;
		case 0x1007 /* ALC_FREQUENCY */:
			if (!device) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			if (!AL.currentCtx) {
				AL.alcErr = 0xA002 /* ALC_INVALID_CONTEXT */;
				return 0;
			}
			{{{ makeSetValue("data", "0", "AL.currentCtx.audioCtx.sampleRate", "i32") }}};
			break;
		case 0x1010 /* ALC_MONO_SOURCES */:
		case 0x1011 /* ALC_STEREO_SOURCES */:
			if (!device) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("data", "0", "0x7FFFFFFF", "i32") }}};
			break;
		case 0x20003 /* ALC_MAX_AUXILIARY_SENDS */:
			if (!device) {
				AL.currentCtx.err = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("data", "0", "1", "i32") }}};
		default:
#if OPENAL_DEBUG
			console.log("alcGetIntegerv() with param " + param + " not implemented yet");
#endif
			AL.alcErr = 0xA003 /* ALC_INVALID_ENUM */;
			break;
		}
	},

	// ***************************************************************************
	// ** AL API 
	// ***************************************************************************

	// -------------------------------------------------------
	// -- AL Resources
	// -------------------------------------------------------

	alGenBuffers: function(count, bufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGenBuffers() called without a valid context");
#endif
			return;
		}

		for (var i = 0; i < count; ++i) {
			var buf = {
				id: AL.buffers.length + 1,
				refCount: 0,
				audioBuf: null
			};
			AL.buffers.push(buf);
			{{{ makeSetValue("bufferIds", "i*4", "buf.id", "i32") }}};
		}
	},

	alDeleteBuffers: function(count, bufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDeleteBuffers() called without a valid context");
#endif
			return;
		}
		if (count > AL.buffers.length) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("bufferIds", "i*4", "i32") }}};

			// Make sure the buffer index is valid.
			if (!AL.buffers[bufId - 1]) {
#if OPENAL_DEBUG
				console.error("alDeleteBuffers() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}

			// Make sure the buffer is no longer in use.
			if (AL.buffers[bufId - 1].refCount) {
#if OPENAL_DEBUG
				console.error("alDeleteBuffers() called with a used buffer");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("bufferIds", "i*4", "i32") }}};
			delete AL.buffers[bufId - 1];
		}
	},

	alGenSources: function(count, sourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGenSources() called without a valid context");
#endif
			return;
		}
		for (var i = 0; i < count; ++i) {
			var gain = AL.currentCtx.audioCtx.createGain();
			gain.connect(AL.currentCtx.gain);
			var src = {
				context: AL.currentCtx,
				id: AL.currentCtx.sources.length + 1,
				type: 0x1030 /* AL_UNDETERMINED */,
				state: 0x1011 /* AL_INITIAL */,
				bufQueue: [],
				audioQueue: [],
				loop: false,
				playbackRate: 1.0,
				_position: [0.0, 0.0, 0.0],
				_velocity: [0.0, 0.0, 0.0],
				_direction: [0.0, 0.0, 0.0],
				get refDistance() {
					return this._refDistance || 1;
				},
				set refDistance(val) {
					this._refDistance = val;
					if (this.panner) this.panner.refDistance = val;
				},
				get maxDistance() {
					return this._maxDistance || 10000.0;
				},
				set maxDistance(val) {
					this._maxDistance = val;
					if (this.panner) this.panner.maxDistance = val;
				},
				get rolloffFactor() {
					return this._rolloffFactor || 1.0;
				},
				set rolloffFactor(val) {
					this._rolloffFactor = val;
					if (this.panner) this.panner.rolloffFactor = val;
				},
				get position() {
					return this._position;
				},
				set position(val) {
					this._position[0] = val[0];
					this._position[1] = val[1];
					this._position[2] = val[2];
					if (this.panner) this.panner.setPosition(val[0], val[1], val[2]);
				},
				get velocity() {
					return this._velocity;
				},
				set velocity(val) {
					this._velocity[0] = val[0];
					this._velocity[1] = val[1];
					this._velocity[2] = val[2];
					// TODO: The velocity values are not currently used to implement a doppler effect.
					// If support for doppler effect is reintroduced, compute the doppler
					// speed pitch factor and apply it here.
				},
				get direction() {
					return this._direction;
				},
				set direction(val) {
					this._direction[0] = val[0];
					this._direction[1] = val[1];
					this._direction[2] = val[2];
					if (this.panner) this.panner.setOrientation(val[0], val[1], val[2]);
				},
				get coneOuterGain() {
					return this._coneOuterGain || 0.0;
				},
				set coneOuterGain(val) {
					this._coneOuterGain = val;
					if (this.panner) this.panner.coneOuterGain = val;
				},
				get coneInnerAngle() {
					return this._coneInnerAngle || 360.0;
				},
				set coneInnerAngle(val) {
					this._coneInnerAngle = val;
					if (this.panner) this.panner.coneInnerAngle = val;
				},
				get coneOuterAngle() {
					return this._coneOuterAngle || 360.0;
				},
				set coneOuterAngle(val) {
					this._coneOuterAngle = val;
					if (this.panner) this.panner.coneOuterAngle = val;
				},
				gain: gain,
				panner: null,
				bufsProcessed: 0,
				bufStartTime: Number.NEGATIVE_INFINITY,
				bufOffset: 0.0
			};
			AL.currentCtx.sources.push(src);
			{{{ makeSetValue("sourceIds", "i*4", "src.id", "i32") }}};
		}
	},

	alDeleteSources__deps: ["alSourcei"],
	alDeleteSources: function(count, sourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDeleteSources() called without a valid context");
#endif
			return;
		}

		for (var i = 0; i < count; ++i) {
			var srcId = {{{ makeGetValue("sourceIds", "i*4", "i32") }}};
			if (!AL.currentCtx.sources[srcId - 1]) {
#if OPENAL_DEBUG
				console.error("alDeleteSources() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			var srcId = {{{ makeGetValue("sourceIds", "i*4", "i32") }}};
			AL.setSourceState(AL.currentCtx.sources[srcId - 1], 0x1014 /* AL_STOPPED */);
			_alSourcei(srcId, 0x1009 /* AL_BUFFER */, 0);
			delete AL.currentCtx.sources[srcId - 1];
		}
	},

	// -------------------------------------------------------
	// --- AL Context State
	// -------------------------------------------------------

	alGetError: function() {
		if (!AL.currentCtx) {
			return 0xA004 /* AL_INVALID_OPERATION */;
		} else {
			// Reset error on get.
			var err = AL.currentCtx.err;
			AL.currentCtx.err = 0 /* AL_NO_ERROR */;
			return err;
		}
	},

	alIsExtensionPresent: function(extName) {
		extName = Pointer_stringify(extName);

		if (extName === "AL_EXT_float32") return 1;

		return 0;
	},

	alGetProcAddress: function(fname) {
		return 0;
	},

	alGetEnumValue: function(name) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetEnumValue() called without a valid context");
#endif
			return 0;
		}

		if (name === 0) {
#if OPENAL_DEBUG
			console.error("alGetEnumValue() called with null pointer");
#endif
			return 0 /* AL_NONE */;
		}
		name = Pointer_stringify(name);

		switch(name) {
		case "AL_FORMAT_MONO_FLOAT32": return 0x10010;
		case "AL_FORMAT_STEREO_FLOAT32": return 0x10011;

		// Spec doesn"t clearly state that alGetEnumValue() is required to
		// support _only_ extension tokens.
		// We should probably follow OpenAL-Soft"s example and support all
		// of the names we know.
		// See http://repo.or.cz/openal-soft.git/blob/HEAD:/Alc/ALc.c
		case "AL_BITS": return 0x2002;
		case "AL_BUFFER": return 0x1009;
		case "AL_BUFFERS_PROCESSED": return 0x1016;
		case "AL_BUFFERS_QUEUED": return 0x1015;
		case "AL_BYTE_OFFSET": return 0x1026;
		case "AL_CHANNELS": return 0x2003;
		case "AL_CONE_INNER_ANGLE": return 0x1001;
		case "AL_CONE_OUTER_ANGLE": return 0x1002;
		case "AL_CONE_OUTER_GAIN": return 0x1022;
		case "AL_DIRECTION": return 0x1005;
		case "AL_DISTANCE_MODEL": return 0xD000;
		case "AL_DOPPLER_FACTOR": return 0xC000;
		case "AL_DOPPLER_VELOCITY": return 0xC001;
		case "AL_EXPONENT_DISTANCE": return 0xD005;
		case "AL_EXPONENT_DISTANCE_CLAMPED": return 0xD006;
		case "AL_EXTENSIONS": return 0xB004;
		case "AL_FORMAT_MONO16": return 0x1101;
		case "AL_FORMAT_MONO8": return 0x1100;
		case "AL_FORMAT_STEREO16": return 0x1103;
		case "AL_FORMAT_STEREO8": return 0x1102;
		case "AL_FREQUENCY": return 0x2001;
		case "AL_GAIN": return 0x100A;
		case "AL_INITIAL": return 0x1011;
		case "AL_INVALID": return -1;
		case "AL_ILLEGAL_ENUM": // fallthrough
		case "AL_INVALID_ENUM": return 0xA002;
		case "AL_INVALID_NAME": return 0xA001;
		case "AL_ILLEGAL_COMMAND": // fallthrough
		case "AL_INVALID_OPERATION": return 0xA004;
		case "AL_INVALID_VALUE": return 0xA003;
		case "AL_INVERSE_DISTANCE": return 0xD001;
		case "AL_INVERSE_DISTANCE_CLAMPED": return 0xD002;
		case "AL_LINEAR_DISTANCE": return 0xD003;
		case "AL_LINEAR_DISTANCE_CLAMPED": return 0xD004;
		case "AL_LOOPING": return 0x1007;
		case "AL_MAX_DISTANCE": return 0x1023;
		case "AL_MAX_GAIN": return 0x100E;
		case "AL_MIN_GAIN": return 0x100D;
		case "AL_NONE": return 0;
		case "AL_NO_ERROR": return 0;
		case "AL_ORIENTATION": return 0x100F;
		case "AL_OUT_OF_MEMORY": return 0xA005;
		case "AL_PAUSED": return 0x1013;
		case "AL_PENDING": return 0x2011;
		case "AL_PITCH": return 0x1003;
		case "AL_PLAYING": return 0x1012;
		case "AL_POSITION": return 0x1004;
		case "AL_PROCESSED": return 0x2012;
		case "AL_REFERENCE_DISTANCE": return 0x1020;
		case "AL_RENDERER": return 0xB003;
		case "AL_ROLLOFF_FACTOR": return 0x1021;
		case "AL_SAMPLE_OFFSET": return 0x1025;
		case "AL_SEC_OFFSET": return 0x1024;
		case "AL_SIZE": return 0x2004;
		case "AL_SOURCE_RELATIVE": return 0x202;
		case "AL_SOURCE_STATE": return 0x1010;
		case "AL_SOURCE_TYPE": return 0x1027;
		case "AL_SPEED_OF_SOUND": return 0xC003;
		case "AL_STATIC": return 0x1028;
		case "AL_STOPPED": return 0x1014;
		case "AL_STREAMING": return 0x1029;
		case "AL_UNDETERMINED": return 0x1030;
		case "AL_UNUSED": return 0x2010;
		case "AL_VELOCITY": return 0x1006;
		case "AL_VENDOR": return 0xB001;
		case "AL_VERSION": return 0xB002;
		}

#if OPENAL_DEBUG
		console.error("No value for `" + name + "` is known by alGetEnumValue()");
#endif
		AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		return 0;
	},

	alGetString: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetString() called without a valid context");
#endif
			return;
		}
		if (AL.stringCache[param]) return AL.stringCache[param];
		var ret;
		switch (param) {
		case 0 /* AL_NO_ERROR */:
			ret = "No Error";
			break;
		case 0xA001 /* AL_INVALID_NAME */:
			ret = "Invalid Name";
			break;
		case 0xA002 /* AL_INVALID_ENUM */:
			ret = "Invalid Enum";
			break;
		case 0xA003 /* AL_INVALID_VALUE */:
			ret = "Invalid Value";
			break;
		case 0xA004 /* AL_INVALID_OPERATION */:
			ret = "Invalid Operation";
			break;
		case 0xA005 /* AL_OUT_OF_MEMORY */:
			ret = "Out of Memory";
			break;
		case 0xB001 /* AL_VENDOR */:
			ret = "Emscripten";
			break;
		case 0xB002 /* AL_VERSION */:
			ret = "1.1";
			break;
		case 0xB003 /* AL_RENDERER */:
			ret = "WebAudio";
			break;
		case 0xB004 /* AL_EXTENSIONS */:
			ret = "AL_EXT_float32";
			break;
		default:
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0;
		}

		ret = allocate(intArrayFromString(ret), "i8", ALLOC_NORMAL);

		AL.stringCache[param] = ret;

		return ret;
	},

	alEnable: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alEnable() called without a valid context");
#endif
			return;
		}
		switch (param) {
		default:
#if OPENAL_DEBUG
			console.error("alEnable() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alDisable: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDisable() called without a valid context");
#endif
			return;
		}
		switch (pname) {
		default:
#if OPENAL_DEBUG
			console.error("alDisable() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alIsEnabled: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alIsEnabled() called without a valid context");
#endif
		}
		switch (pname) {
		default:
#if OPENAL_DEBUG
			console.error("alIsEnabled() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}

		return 0;
	},

	// In this section, all alGet*() functions can be implemented by casting the
	// return value of alGetDouble().
	// For v-suffixed variants, the spec requires that NULL destination 
	// pointers be quietly ignored.
	
	alGetDouble: function(param) {
		return AL.getDoubleHelper("alGetDouble", param);
	},

	alGetDoublev: function(param, data) {
		var val = AL.getDoubleHelper("alGetDoublev", param);
		if (!data) {
			return;
		}
		{{{ makeSetValue("data", "0", "val", "double") }}};
	},

	alGetBoolean: function(param) {
		return !!AL.getDoubleHelper("alGetBoolean", param);
	},

	alGetBooleanv: function(param, data) {
		var val = !!AL.getDoubleHelper("alGetBooleanv", param);
		if (!data) {
			return;
		}
		{{{ makeSetValue("data", "0", "val", "i8") }}};
	},

	alGetFloat: function(param) {
		return AL.getDoubleHelper("alGetFloat", param);
	},

	alGetFloatv: function(param, data) {
		var val = AL.getDoubleHelper("alGetFloatv", param);
		if (!data) {
			return;
		}
		{{{ makeSetValue("data", "0", "val", "float") }}};
	},

	alGetInteger: function(param) {
		return AL.getDoubleHelper("alGetInteger", param);
	},

	alGetIntegerv: function(param, data) {
		var val = AL.getDoubleHelper("alGetIntegerv", param);
		if (!data) {
			return;
		}
		{{{ makeSetValue("data", "0", "val", "i32") }}};
	},

	alDistanceModel: function(model) {
		if (model !== 0 /* AL_NONE */) {
#if OPENAL_DEBUG
			console.log("Only alDistanceModel(AL_NONE) is currently supported");
#endif
		}
	},

	alDopplerFactor: function(value) {
		Runtime.warnOnce("alDopplerFactor() is not yet implemented!");
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDopplerFactor() called without a valid context");
#endif
			return;
		}
		if (value < 0) { // Strictly negative values are disallowed
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		// TODO actual impl here
	},

	// http://openal.996291.n3.nabble.com/alSpeedOfSound-or-alDopperVelocity-tp1960.html
	// alDopplerVelocity() sets a multiplier for the speed of sound.
	// It"s deprecated since it"s equivalent to directly calling
	// alSpeedOfSound() with an appropriately premultiplied value.
	alDopplerVelocity: function(value) {
		Runtime.warnOnce("alDopplerVelocity() is deprecated, and only kept for compatibility with OpenAL 1.0. Use alSpeedOfSound() instead.");
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDopplerVelocity() called without a valid context");
#endif
			return;
		}
		if (value <= 0) { // Negative or zero values are disallowed
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
	},

	alSpeedOfSound: function(value) {
		Runtime.warnOnce("alSpeedOfSound() is not yet implemented!");
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSpeedOfSound() called without a valid context");
#endif
			return;
		}
		if (value <= 0) { // Negative or zero values are disallowed
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		// TODO actual impl here
	},

	alDopplerFactor: function(value) {
		Runtime.warnOnce("alDopplerFactor() is not yet implemented! Ignoring all calls to it.");
	},

	// -------------------------------------------------------
	// -- AL Listener State
	// -------------------------------------------------------

	alGetListeneri: function(pname, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetListeneri() called without a valid context");
#endif
			return;
		}
		switch (pname) {
		default:
#if OPENAL_DEBUG
			console.error("alGetListeneri() with param " + pname + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetListener3i: function(param, v1, v2, v3) {
		var v = AL.getListenerHelper("alGetListener3i", param);
		if (!v) return;
		{{{ makeSetValue("v1", "0", "v[0]", "i32") }}};
		{{{ makeSetValue("v2", "0", "v[1]", "i32") }}};
		{{{ makeSetValue("v3", "0", "v[2]", "i32") }}};
	},

	alGetListeneriv: function(param, data) {
		var v = AL.getListenerHelper("alGetListeneriv", param);
		if (!v) return;
		{{{ makeSetValue("data", "0", "v[0]", "i32") }}};
		{{{ makeSetValue("data", "4", "v[1]", "i32") }}};
		{{{ makeSetValue("data", "8", "v[2]", "i32") }}};

		if (param === 0x100F /* AL_ORIENTATION */) {
			{{{ makeSetValue("data", "12", "v[3]", "i32") }}};
			{{{ makeSetValue("data", "16", "v[4]", "i32") }}};
			{{{ makeSetValue("data", "20", "v[5]", "i32") }}};
		}
	},

	alGetListenerf: function(pname, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetListenerf() called without a valid context");
#endif
			return;
		}
		switch (pname) {
		case 0x100A /* AL_GAIN */:
			{{{ makeSetValue("value", "0", "AL.currentCtx.gain.gain.value", "float") }}}
			break;
		default:
#if OPENAL_DEBUG
			console.error("alGetListenerf() with param " + pname + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetListener3f: function(param, v1, v2, v3) {
		var v = AL.getListenerHelper("alGetListener3f", param);
		if (!v) return;
		{{{ makeSetValue("v1", "0", "v[0]", "float") }}};
		{{{ makeSetValue("v2", "0", "v[1]", "float") }}};
		{{{ makeSetValue("v3", "0", "v[2]", "float") }}};
	},

	alGetListenerfv: function(pname, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetListenerfv() called without a valid context");
#endif
			return;
		}
		switch (pname) {
		case 0x1004 /* AL_POSITION */:
			var position = AL.currentCtx.audioCtx.listener._position;
			{{{ makeSetValue("values", "0", "position[0]", "float") }}}
			{{{ makeSetValue("values", "4", "position[1]", "float") }}}
			{{{ makeSetValue("values", "8", "position[2]", "float") }}}
			break;
		case 0x1006 /* AL_VELOCITY */:
			var velocity = AL.currentCtx.audioCtx.listener._velocity;
			{{{ makeSetValue("values", "0", "velocity[0]", "float") }}}
			{{{ makeSetValue("values", "4", "velocity[1]", "float") }}}
			{{{ makeSetValue("values", "8", "velocity[2]", "float") }}}
			break;
		case 0x100F /* AL_ORIENTATION */:
			var orientation = AL.currentCtx.audioCtx.listener._orientation;
			{{{ makeSetValue("values", "0", "orientation[0]", "float") }}}
			{{{ makeSetValue("values", "4", "orientation[1]", "float") }}}
			{{{ makeSetValue("values", "8", "orientation[2]", "float") }}}
			{{{ makeSetValue("values", "12", "orientation[3]", "float") }}}
			{{{ makeSetValue("values", "16", "orientation[4]", "float") }}}
			{{{ makeSetValue("values", "20", "orientation[5]", "float") }}}
			break;
		default:
#if OPENAL_DEBUG
			console.error("alGetListenerfv() with param " + pname + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alListeneri: function(param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListeneri() called without a valid context");
#endif
			return;
		}
		// Quoting the programmer"s guide:
		// There are no integer listener attributes defined for OpenAL 1.1,
		// but this function may be used by an extension.
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alListener3i__deps: ["alListener3f"],
	alListener3i: function(param, v1, v2, v3) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListener3i called without a valid context");
#endif
			return;
		}

		_alListener3f(param, v1, v2, v3);
	},

	// Would have liked to leverage alListenerfv(), but saw no "nice enough" way
	// to do it. Copy pasta.
	alListeneriv: function(param, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListeneriv() called without a valid context");
#endif
			return;
		}
		switch (param) {
		case 0x1004 /* AL_POSITION */:
			var x = {{{ makeGetValue("values", "0", "i32") }}};
			var y = {{{ makeGetValue("values", "4", "i32") }}};
			var z = {{{ makeGetValue("values", "8", "i32") }}};
			AL.currentCtx.audioCtxx.listener._position[0] = x;
			AL.currentCtx.audioCtxx.listener._position[1] = y;
			AL.currentCtx.audioCtxx.listener._position[2] = z;
			AL.currentCtx.audioCtxx.listener.setPosition(x, y, z);
			break;
		case 0x1006 /* AL_VELOCITY */:
			var x = {{{ makeGetValue("values", "0", "i32") }}};
			var y = {{{ makeGetValue("values", "4", "i32") }}};
			var z = {{{ makeGetValue("values", "8", "i32") }}};
			AL.currentCtx.audioCtxx.listener._velocity[0] = x;
			AL.currentCtx.audioCtxx.listener._velocity[1] = y;
			AL.currentCtx.audioCtxx.listener._velocity[2] = z;
			// TODO: The velocity values are not currently used to implement a doppler effect.
			// If support for doppler effect is reintroduced, compute the doppler
			// speed pitch factor and apply it here.
			break;
		case 0x100F /* AL_ORIENTATION */:
			var x = {{{ makeGetValue("values", "0", "i32") }}};
			var y = {{{ makeGetValue("values", "4", "i32") }}};
			var z = {{{ makeGetValue("values", "8", "i32") }}};
			var x2 = {{{ makeGetValue("values", "12", "i32") }}};
			var y2 = {{{ makeGetValue("values", "16", "i32") }}};
			var z2 = {{{ makeGetValue("values", "20", "i32") }}};
			AL.currentCtx.audioCtxx.listener._orientation[0] = x;
			AL.currentCtx.audioCtxx.listener._orientation[1] = y;
			AL.currentCtx.audioCtxx.listener._orientation[2] = z;
			AL.currentCtx.audioCtxx.listener._orientation[3] = x2;
			AL.currentCtx.audioCtxx.listener._orientation[4] = y2;
			AL.currentCtx.audioCtxx.listener._orientation[5] = z2;
			AL.currentCtx.audioCtxx.listener.setOrientation(x, y, z, x2, y2, z2);
			break;
		default:
#if OPENAL_DEBUG
			console.error("alListeneriv() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alListenerf: function(param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListenerf() called without a valid context");
#endif
			return;
		}
		switch (param) {
		case 0x100A /* AL_GAIN */:
			if (AL.currentCtx.gain.gain.value != value) AL.currentCtx.gain.gain.value = value;
			break;
		default:
#if OPENAL_DEBUG
			console.error("alListenerf() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alListener3f: function(param, v1, v2, v3) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListener3f() called without a valid context");
#endif
			return;
		}
		switch (param) {
		case 0x1004 /* AL_POSITION */:
			AL.currentCtx.audioCtx.listener._position[0] = v1;
			AL.currentCtx.audioCtx.listener._position[1] = v2;
			AL.currentCtx.audioCtx.listener._position[2] = v3;
			AL.currentCtx.audioCtx.listener.setPosition(v1, v2, v3);
			break;
		case 0x1006 /* AL_VELOCITY */:
			AL.currentCtx.audioCtx.listener._velocity[0] = v1;
			AL.currentCtx.audioCtx.listener._velocity[1] = v2;
			AL.currentCtx.audioCtx.listener._velocity[2] = v3;
			// TODO: The velocity values are not currently used to implement a doppler effect.
			// If support for doppler effect is reintroduced, compute the doppler
			// speed pitch factor and apply it here.
			break;
		default:
#if OPENAL_DEBUG
			console.error("alListener3f() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alListenerfv: function(param, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alListenerfv() called without a valid context");
#endif
			return;
		}
		switch (param) {
		case 0x1004 /* AL_POSITION */:
			var x = {{{ makeGetValue("values", "0", "float") }}};
			var y = {{{ makeGetValue("values", "4", "float") }}};
			var z = {{{ makeGetValue("values", "8", "float") }}};
			AL.currentCtx.audioCtx.listener._position[0] = x;
			AL.currentCtx.audioCtx.listener._position[1] = y;
			AL.currentCtx.audioCtx.listener._position[2] = z;
			AL.currentCtx.audioCtx.listener.setPosition(x, y, z);
			break;
		case 0x1006 /* AL_VELOCITY */:
			var x = {{{ makeGetValue("values", "0", "float") }}};
			var y = {{{ makeGetValue("values", "4", "float") }}};
			var z = {{{ makeGetValue("values", "8", "float") }}};
			AL.currentCtx.audioCtx.listener._velocity[0] = x;
			AL.currentCtx.audioCtx.listener._velocity[1] = y;
			AL.currentCtx.audioCtx.listener._velocity[2] = z;
			// TODO: The velocity values are not currently used to implement a doppler effect.
			// If support for doppler effect is reintroduced, compute the doppler
			// speed pitch factor and apply it here.
			break;
		case 0x100F /* AL_ORIENTATION */:
			var x = {{{ makeGetValue("values", "0", "float") }}};
			var y = {{{ makeGetValue("values", "4", "float") }}};
			var z = {{{ makeGetValue("values", "8", "float") }}};
			var x2 = {{{ makeGetValue("values", "12", "float") }}};
			var y2 = {{{ makeGetValue("values", "16", "float") }}};
			var z2 = {{{ makeGetValue("values", "20", "float") }}};
			AL.currentCtx.audioCtx.listener._orientation[0] = x;
			AL.currentCtx.audioCtx.listener._orientation[1] = y;
			AL.currentCtx.audioCtx.listener._orientation[2] = z;
			AL.currentCtx.audioCtx.listener._orientation[3] = x2;
			AL.currentCtx.audioCtx.listener._orientation[4] = y2;
			AL.currentCtx.audioCtx.listener._orientation[5] = z2;
			AL.currentCtx.audioCtx.listener.setOrientation(x, y, z, x2, y2, z2);
			break;
		default:
#if OPENAL_DEBUG
			console.error("alListenerfv() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	// -------------------------------------------------------
	// -- AL Buffer State
	// -------------------------------------------------------

	alIsBuffer: function(bufferId) {
		if (!AL.currentCtx) {
			return false;
		}
		if (bufferId > AL.buffers.length) {
			return false;
		}

		if (!AL.buffers[bufferId - 1]) {
			return false;
		} else {
			return true;
		}
	},

	alBufferData: function(bufferId, format, data, size, freq) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alBufferData() called without a valid context");
#endif
			return;
		}

		var buf = AL.buffers[bufferId - 1];
		if (!buf) {
#if OPENAL_DEBUG
			console.error("alBufferData() called with an invalid buffer");
#endif
			return;
		}

		try {
			switch (format) {
			case 0x1100 /* AL_FORMAT_MONO8 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size, freq);
				ab.bytesPerSample = 1;
				var channel0 = ab.getChannelData(0);
				for (var i = 0; i < size; ++i) channel0[i] = HEAPU8[data++] * 0.0078125 /* 1/128 */ - 1.0;
				break;
			case 0x1101 /* AL_FORMAT_MONO16 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size>>1, freq);
				ab.bytesPerSample = 2;
				var channel0 = ab.getChannelData(0);
				data >>= 1;
				for (var i = 0; i < size>>1; ++i) channel0[i] = HEAP16[data++] * 0.000030517578125 /* 1/32768 */;
				break;
			case 0x1102 /* AL_FORMAT_STEREO8 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>1, freq);
				ab.bytesPerSample = 1;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				for (var i = 0; i < size>>1; ++i) {
					channel0[i] = HEAPU8[data++] * 0.0078125 /* 1/128 */ - 1.0;
					channel1[i] = HEAPU8[data++] * 0.0078125 /* 1/128 */ - 1.0;
				}
				break;
			case 0x1103 /* AL_FORMAT_STEREO16 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>2, freq);
				ab.bytesPerSample = 2;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				data >>= 1;
				for (var i = 0; i < size>>2; ++i) {
					channel0[i] = HEAP16[data++] * 0.000030517578125 /* 1/32768 */;
					channel1[i] = HEAP16[data++] * 0.000030517578125 /* 1/32768 */;
				}
				break;
			case 0x10010 /* AL_FORMAT_MONO_FLOAT32 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size>>2, freq);
				ab.bytesPerSample = 4;
				var channel0 = ab.getChannelData(0);
				data >>= 2;
				for (var i = 0; i < size>>2; ++i) channel0[i] = HEAPF32[data++];
				break;
			case 0x10011 /* AL_FORMAT_STEREO_FLOAT32 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>3, freq);
				ab.bytesPerSample = 4;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				data >>= 2;
				for (var i = 0; i < size>>2; ++i) {
					channel0[i] = HEAPF32[data++];
					channel1[i] = HEAPF32[data++];
				}
				break;
			default:
#if OPENAL_DEBUG
				console.error("alBufferData() called with invalid format " + format);
#endif
				AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
				break;
			}
			buf.audioBuf = ab;
		} catch (e) {
#if OPENAL_DEBUG
			console.error("alBufferData() upload failed with an exception " + e);
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
	},

	alGetBufferi: function(bufferId, param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetBufferi() called without a valid context");
#endif
			return;
		}
		var buf = AL.buffers[buffer - 1];
		if (!buf) {
#if OPENAL_DEBUG
			console.error("alGetBufferi() called with an invalid buffer");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x2001 /* AL_FREQUENCY */:
			{{{ makeSetValue("value", "0", "buf.audioBuf.sampleRate", "i32") }}};
			break;
		case 0x2002 /* AL_BITS */:
			{{{ makeSetValue("value", "0", "buf.audioBuf.bytesPerSample * 8", "i32") }}};
			break;
		case 0x2003 /* AL_CHANNELS */:
			{{{ makeSetValue("value", "0", "buf.audioBuf.numberOfChannels", "i32") }}};
			break;
		case 0x2004 /* AL_SIZE */:
			{{{ makeSetValue("value", "0", "buf.audioBuf.length * buf.audioBuf.bytesPerSample * buf.audioBuf.numberOfChannels", "i32") }}};
			break;
		default:
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetBuffer3i: function(buffer, pname, v1, v2, v3) {
		if (!v1 || !v2 || !v3) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		AL.bufferDummyAccessor("alGetBuffer3i", buffer);
	},

	alGetBufferiv__deps: ["alGetBufferi"],
	alGetBufferiv: function(buffer, pname, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetBufferiv called without a valid context");
#endif
			return;
		}
		_alGetBufferi(buffer, pname, values);
	},

	// These in particular can error with AL_INVALID_VALUE
	// "if the destination pointer is not valid"
	// (from the programming guide)

	alGetBufferf: function(buffer, pname, value) {
		if (!value) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		AL.bufferDummyAccessor("alGetBufferf", buffer);
	},

	alGetBuffer3f: function(buffer, pname, v1, v2, v3) {
		if (!v1 || !v2 || !v3) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		AL.bufferDummyAccessor("alGetBuffer3f", buffer);
	},

	alGetBufferfv: function(buffer, pname, values) {
		if (!values) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
		AL.bufferDummyAccessor("alGetBufferfv", buffer);
	},

	// All of the remaining alBuffer* setters and getters are only of interest
	// to extensions which need them. Core OpenAL alone defines no valid
	// property for these.

	alBufferi: function(buffer, param, value) {
		AL.bufferDummyAccessor("alBufferi()", buffer);
	},

	alBuffer3i: function(buffer, param, v1, v2, v3) {
		AL.bufferDummyAccessor("alBuffer3i()", buffer);
	},

	alBufferiv: function(buffer, params, values) {
		AL.bufferDummyAccessor("alBufferiv()", buffer);
	},

	alBufferf: function(buffer, param, value) {
		AL.bufferDummyAccessor("alBufferf()", buffer);
	},

	alBuffer3f: function(buffer, param, v1, v2, v3) {
		AL.bufferDummyAccessor("alBuffer3f()", buffer);
	},

	alBufferfv: function(buffer, param, values) {
		AL.bufferDummyAccessor("alBufferfv()", buffer);
	},

	// -------------------------------------------------------
	// -- AL Source State
	// -------------------------------------------------------

	alIsSource: function(sourceId) {
		if (!AL.currentCtx) {
			return false;
		}

		if (!AL.currentCtx.sources[sourceId - 1]) {
			return false;
		} else {
			return true;
		}
	},

	alSourceQueueBuffers: function(sourceId, count, buffers) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		if (src.type === 0x1028 /* AL_STATIC */) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called while a static buffer is bound");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		for (var i = 0; i < count; ++i) {
			var bufferId = {{{ makeGetValue("buffers", "i*4", "i32") }}};
			if (!AL.buffers[bufferId - 1]) {
#if OPENAL_DEBUG
				console.error("alSourceQueueBuffers() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		src.type = 0x1029 /* AL_STREAMING */;
		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("buffers", "i*4", "i32") }}};
			var buf = AL.buffers[bufId - 1];
			buf.refCount++;
			src.bufQueue.push(buf);
		}

		// if the source is looping, cancel the schedule so we can reschedule the loop order
		if (src.loop) {
			AL.cancelPendingSourceAudio(src);
		}
		AL.scheduleSourceAudio(src);
	},

	alSourceUnqueueBuffers: function(sourceId, count, bufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceUnqueueBuffers() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceUnqueueBuffers() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}

		if (count > src.bufsProcessed) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		for (var i = 0; i < count; i++) {
			var buf = src.bufQueue.shift();
			buf.refCount--;
			// Write the buffers index out to the return list.
			{{{ makeSetValue("bufferIds", "i*4", "buf.id", "i32") }}};
			src.bufsProcessed--;
		}

		AL.scheduleSourceAudio(src);
	},

	alSourcePlay: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePlay() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcePlay() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1012 /* AL_PLAYING */);
	},

	alSourcePlayv: function(count, sources) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePlayv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (sources === 0) {
#if OPENAL_DEBUG
			console.error("alSourcePlayv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("sources", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourcePlayv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("sources", "i*4", "i32") }}}, 0x1012 /* AL_PLAYING */);
		}
	},

	alSourceStop: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceStop() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceStop() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
	},

	alSourceStopv: function(count, sources) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceStopv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (sources === 0) {
#if OPENAL_DEBUG
			console.error("alSourceStopv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("sources", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourceStopv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("sources", "i*4", "i32") }}}, 0x1014 /* AL_STOPPED */);
		}
	},

	alSourceRewind: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceRewind() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceRewind() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		// Stop the source first to clear the source queue
		AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
		// Now set the state of AL_INITIAL according to the specification
		AL.setSourceState(src, 0x1011 /* AL_INITIAL */);
	},

	alSourceRewindv: function(count, sources) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceRewindv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (sources === 0) {
#if OPENAL_DEBUG
			console.error("alSourceRewindv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("sources", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourceRewindv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("sources", "i*4", "i32") }}}, 0x1011 /* AL_INITIAL */);
		}
	},

	alSourcePause: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePause() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcePause() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1013 /* AL_PAUSED */);
	},

	alSourcePausev: function(count, sources) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePausev() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (sources === 0) {
#if OPENAL_DEBUG
			console.error("alSourcePausev() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("sources", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourcePausev() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("sources", "i*4", "i32") }}}, 0x1013 /* AL_PAUSED */);
		}
	},

	alGetSourcei: function(sourceId, param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetSourcei() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alGetSourcei() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}

		// Being that we have no way to receive end events from buffer nodes,
		// we currently proccess and update a source"s buffer queue every
		// ~QUEUE_INTERVAL milliseconds. However, this interval is not precise,
		// so we also forcefully update the source when alGetSourcei is queried
		// to aid in the common scenario of application calling alGetSourcei(AL_BUFFERS_PROCESSED)
		// to recycle buffers.
		AL.scheduleSourceAudio(src);

		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
			{{{ makeSetValue("value", "0", "src.panner ? 1 : 0", "i32") }}};
			break;
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
			{{{ makeSetValue("value", "0", "src.coneInnerAngle", "i32") }}};
			break;
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
			{{{ makeSetValue("value", "0", "src.coneOuterAngle", "i32") }}};
			break;
		case 0x1007 /* AL_LOOPING */:
			{{{ makeSetValue("value", "0", "src.loop", "i32") }}};
			break;
		case 0x1009 /* AL_BUFFER */:
			if (src.type === 0x1028 /* AL_STATIC */) {
				var buf = src.bufQueue[0];
				{{{ makeSetValue("value", "0", "buf.id", "i32") }}};
			} else {
				{{{ makeSetValue("value", "0", "0", "i32") }}};
			}
			break;
		case 0x1010 /* AL_SOURCE_STATE */:
			{{{ makeSetValue("value", "0", "src.state", "i32") }}};
			break;
		case 0x1015 /* AL_BUFFERS_QUEUED */:
			{{{ makeSetValue("value", "0", "src.bufQueue.length", "i32") }}}
			break;
		case 0x1016 /* AL_BUFFERS_PROCESSED */:
			if (src.loop) {
				{{{ makeSetValue("value", "0", "0", "i32") }}}
			} else {
				{{{ makeSetValue("value", "0", "src.bufsProcessed", "i32") }}}
			}
			break;
		case 0x1027 /* AL_SOURCE_TYPE */:
			{{{ makeSetValue("value", "0", "src.type", "i32") }}}
			break;
		default:
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetSource3i: function(source, param, v1, v2, v3) {
		var v = AL.getSource3Helper("alGetSource3i", source, param);
		if (!v) return;
		{{{ makeSetValue("v1", "0", "v[0]", "i32") }}};
		{{{ makeSetValue("v2", "0", "v[1]", "i32") }}};
		{{{ makeSetValue("v3", "0", "v[2]", "i32") }}};
	},

	alGetSourceiv__deps: ["alGetSourcei"],
	alGetSourceiv: function(sourceId, param, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetSourceiv() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alGetSourceiv() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1007 /* AL_LOOPING */:
		case 0x1009 /* AL_BUFFER */:
		case 0x1010 /* AL_SOURCE_STATE */:
		case 0x1015 /* AL_BUFFERS_QUEUED */:
		case 0x1016 /* AL_BUFFERS_PROCESSED */:
			_alGetSourcei(sourceId, param, values);
			break;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourceiv() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetSourcef: function(sourceId, param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetSourcef() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alGetSourcef() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x1003 /* AL_PITCH */:
			{{{ makeSetValue("value", "0", "src.playbackRate", "float") }}}
			break;
		case 0x100A /* AL_GAIN */:
			{{{ makeSetValue("value", "0", "src.gain.gain.value", "float") }}}
			break;
		// case 0x100D /* AL_MIN_GAIN */:
		// break;
		// case 0x100E /* AL_MAX_GAIN */:
		// break;
		case 0x1023 /* AL_MAX_DISTANCE */:
			{{{ makeSetValue("value", "0", "src.maxDistance", "float") }}}
			break;
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
			{{{ makeSetValue("value", "0", "src.rolloffFactor", "float") }}}
			break;
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
			{{{ makeSetValue("value", "0", "src.coneOuterGain", "float") }}}
			break;
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
			{{{ makeSetValue("value", "0", "src.coneInnerAngle", "float") }}}
			break;
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
			{{{ makeSetValue("value", "0", "src.coneOuterAngle", "float") }}}
			break;
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
			{{{ makeSetValue("value", "0", "src.refDistance", "float") }}}
			break;
		// case 0x1024 /* AL_SEC_OFFSET */:
		// break;
		// case 0x1025 /* AL_SAMPLE_OFFSET */:
		// break;
		// case 0x1026 /* AL_BYTE_OFFSET */:
		// break;
		default:
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alGetSource3f: function(source, param, v1, v2, v3) {
		var v = AL.getSource3Helper("alGetSource3f", source, param);
		if (!v) return;
		{{{ makeSetValue("v1", "0", "v[0]", "float") }}};
		{{{ makeSetValue("v2", "0", "v[1]", "float") }}};
		{{{ makeSetValue("v3", "0", "v[2]", "float") }}};
	},

	alGetSourcefv__deps: ["alGetSourcef"],
	alGetSourcefv: function(sourceId, param, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetSourcefv() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alGetSourcefv() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x1003 /* AL_PITCH */:
		case 0x100A /* AL_GAIN */:
		case 0x100D /* AL_MIN_GAIN */:
		case 0x100E /* AL_MAX_GAIN */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			_alGetSourcef(sourceId, param, values);
			break;
		case 0x1004 /* AL_POSITION */:
			var position = src.position;
			{{{ makeSetValue("values", "0", "position[0]", "float") }}}
			{{{ makeSetValue("values", "4", "position[1]", "float") }}}
			{{{ makeSetValue("values", "8", "position[2]", "float") }}}
			break;
		case 0x1005 /* AL_DIRECTION */:
			var direction = src.direction;
			{{{ makeSetValue("values", "0", "direction[0]", "float") }}}
			{{{ makeSetValue("values", "4", "direction[1]", "float") }}}
			{{{ makeSetValue("values", "8", "direction[2]", "float") }}}
			break;
		case 0x1006 /* AL_VELOCITY */:
			var velocity = src.velocity;
			{{{ makeSetValue("values", "0", "velocity[0]", "float") }}}
			{{{ makeSetValue("values", "4", "velocity[1]", "float") }}}
			{{{ makeSetValue("values", "8", "velocity[2]", "float") }}}
			break;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourcefv() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alSourcei: function(sourceId, param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcei() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcei() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
			src.coneInnerAngle = value;
			break;
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
			src.coneOuterAngle = value;
			break;
		case 0x1007 /* AL_LOOPING */:
			src.loop = (value === 1 /* AL_TRUE */);
			break;
		case 0x1009 /* AL_BUFFER */:
			if (src.state === 0x1012 /* AL_PLAYING */ || src.state === 0x1013 /* AL_PAUSED */) {
#if OPENAL_DEBUG
				console.error("alSourcei(AL_BUFFER) called while source is playing or paused");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}

			if (value === 0) {
				for (var i in src.bufQueue) {
					src.bufQueue[i].refCount--;
				}
				src.bufQueue.length = 0;

				src.bufsProcessed = 0;
				src.type = 0x1030 /* AL_UNDETERMINED */;
			} else {
				var buf = AL.buffers[value - 1];
				if (!buf) {
#if OPENAL_DEBUG
					console.error("alSourcei(AL_BUFFER) called with an invalid buffer");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}

				for (var i in src.bufQueue) {
					src.bufQueue[i].refCount--;
				}
				src.bufQueue.length = 0;

				buf.refCount++;
				src.bufQueue = [buf];
				src.bufsProcessed = 0;
				src.type = 0x1028 /* AL_STATIC */;
			}

			AL.scheduleSourceAudio(src);
			break;
		case 0x202 /* AL_SOURCE_RELATIVE */:
			if (value === 1 /* AL_TRUE */) {
				if (src.panner) {
					src.panner = null;

					// Disconnect from the panner.
					src.gain.disconnect();

					src.gain.connect(AL.currentCtx.gain);
				}
			} else if (value === 0 /* AL_FALSE */) {
				if (!src.panner) {
					var panner = src.panner = AL.currentCtx.audioCtx.createPanner();
					panner.panningModel = "equalpower";
					panner.distanceModel = "linear";
					panner.refDistance = src.refDistance;
					panner.maxDistance = src.maxDistance;
					panner.rolloffFactor = src.rolloffFactor;
					panner.setPosition(src.position[0], src.position[1], src.position[2]);
					// TODO: If support for doppler effect is reintroduced, compute the doppler
					// speed pitch factor and apply it here.
					panner.connect(AL.currentCtx.gain);

					// Disconnect from the default source.
					src.gain.disconnect();

					src.gain.connect(panner);
				}
			} else {
				AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			}
			break;
		default:
#if OPENAL_DEBUG
			console.log("alSourcei() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alSource3i__deps: ["alSource3f"],
	alSource3i: function(sourceId, param, v1, v2, v3) {
		_alSource3f(sourceId, param, v1, v2, v3);
	},

	alSourceiv__deps: ["alSource3i"],
	alSourceiv: function(source, param, values) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceiv called without a valid context");
#endif
			return;
		}

		_alSource3i(source, param,
			{{{ makeGetValue("values", "0", "i32") }}},
			{{{ makeGetValue("values", "4", "i32") }}},
			{{{ makeGetValue("values", "8", "i32") }}});
	},

	alSourcef: function(sourceId, param, value) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcef() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcef() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x1003 /* AL_PITCH */:
			if (value <= 0) {
				AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
				return;
			}

			if (src.playbackRate === value) {
				return;
			}
			src.playbackRate = value;

			if (src.state === 0x1012 /* AL_PLAYING */) {
				// clear scheduled buffers
				AL.cancelPendingSourceAudio(src);

				var audioSrc = src.audioQueue[0];
				if (!audioSrc) {
					return; // It is possible that AL.scheduleContextAudio() has not yet fed the next buffer, if so, skip.
				}
				var oldrate = audioSrc.playbackRate.value;
				// audioSrc._duration is expressed after factoring in playbackRate, so when changing playback rate, need
				// to recompute/rescale the rate to the new playback speed.
				audioSrc._duration = audioSrc._duration * oldrate / src.playbackRate;
				audioSrc.playbackRate.value = src.playbackRate;

				// reschedule buffers with the new playbackRate
				AL.scheduleSourceAudio(src);
			}
			break;
		case 0x100A /* AL_GAIN */:
			if (src.gain.gain.value != value) src.gain.gain.value = value;
			break;
		// case 0x100D /* AL_MIN_GAIN */:
		// break;
		// case 0x100E /* AL_MAX_GAIN */:
		// break;
		case 0x1023 /* AL_MAX_DISTANCE */:
			src.maxDistance = value;
			break;
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
			src.rolloffFactor = value;
			break;
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
			src.coneOuterGain = value;
			break;
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
			src.coneInnerAngle = value;
			break;
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
			src.coneOuterAngle = value;
			break;
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
			src.refDistance = value;
			break;
		default:
#if OPENAL_DEBUG
			console.log("alSourcef() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alSource3f: function(sourceId, param, v1, v2, v3) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSource3f() called without a valid context");
#endif
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSource3f() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		switch (param) {
		case 0x1004 /* AL_POSITION */:
			src.position[0] = v1;
			src.position[1] = v2;
			src.position[2] = v3;
			break;
		case 0x1005 /* AL_DIRECTION */:
			src.direction[0] = v1;
			src.direction[1] = v2;
			src.direction[2] = v3;
			break;
		case 0x1006 /* AL_VELOCITY */:
			src.velocity[0] = v1;
			src.velocity[1] = v2;
			src.velocity[2] = v3;
			break;
		default:
#if OPENAL_DEBUG
			console.log("alSource3f() with param " + param + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alSourcefv__deps: ["alSource3f"],
	alSourcefv: function(sourceId, param, value) {
		_alSource3f(sourceId, param,
			{{{ makeGetValue("value", "0", "float") }}},
			{{{ makeGetValue("value", "4", "float") }}},
			{{{ makeGetValue("value", "8", "float") }}});
	}
};

autoAddDeps(LibraryOpenAL, "$AL");
mergeInto(LibraryManager.library, LibraryOpenAL);

