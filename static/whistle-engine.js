function WhistleEngine() {
	const CallState =
	{
		Idle: 'Idle',
		Active: 'Active'
	}

	const ConnectivityState =
	{
		Green: 'Green',
		Yellow: 'Yellow',
		Red: 'Red'
	}

	this.start = function (config) {
		var engine = this;

		this.config = config;
		this.state = CallState.Idle;

		if (config.debug)
			JsSIP.debug.enable('JsSIP:*');

		var proxyuri;

		if (config.insecure)
			proxyuri = "ws://";
		else
			proxyuri = "wss://";

		proxyuri += config.proxy;

		if (config.port)
			proxyuri += ":" + config.port;

		var domain;
		if (config.domain)
			domain = config.domain
		else
			domain = config.proxy

		var socket = new JsSIP.WebSocketInterface(proxyuri);
		var jssc_config =
		{
			sockets: [socket],
			"outbound_proxy_set": proxyuri,
			"ws_servers": proxyuri,
			"uri": "sip:" + config.user + "@" + config.domain,
			"authorization_jwt": config.authorization_jwt
		};

		if (config.register && config.register == false)
			jssc_config.register = false;
		else
			jssc_config.register = true;

		this.ua = new JsSIP.UA(jssc_config);

		this.ua.on('registered', function (e) {
			if (engine.config.registered)
				engine.config.registered();
		});

		this.ua.on('unregistered', function (e) {
			if (engine.config.unregistered)
				engine.config.unregistered();
		})

		this.ua.on('peerconnection', function (e) {
			console.log("peerconnection");
			console.log(e.session._connection);
		});

		this.ua.on('newRTCSession', function (e) {
			engine.session = e.session;

			engine.session.on('peerconnection', function (e) {
				engine._startAudio();
			});

			for (let i of ['peerconnection:setremotedescriptionfailed',
				'peerconnection:createofferfailed',
				'peerconnection:createanswerfailed',
				'peerconnection:setlocaldescriptionfailed',
				'getusermediafailed']) {
				engine.session.on(i, function (e) {
					engine._call_failure();
				});
			}

			engine._startAudio();

			if (e.originator == 'remote') {
				engine._setState(CallState.Active);

				if (engine.config.incoming_call)
					engine.config.incoming_call(e.session.remote_identity.uri, e.session.remote_identity.display_name);
			}

			if (!engine.statTimer) {
				engine.connectivityState = undefined;
				engine.inbound_stats = undefined;
				engine.statTimer = setInterval(engine._statUpdate, 5000);
				engine._connectivityUpdate(ConnectivityState.Green);
			}
		});

		this.ua.start();
	}

	this.stop = function () {
		this.ua.stop();
		ua = null;

		return (true);
	}

	this.dial = function (user, options) {
		if (this.state != CallState.Idle)
			return (false);

		var jssopts = this._jss_options();

		if (options && options.extraHeaders)
			jssopts.extraHeaders = options.extraHeaders;

		this.ua.call(this._userToURI(user), jssopts);
		this._setState(CallState.Active);

		return (true);
	}

	this.answer = function () {
		this.session.answer(this._jss_options());
		return (true);
	}

	this.hangup = function () {
		this.session.terminate();
		engine._setState(CallState.Idle);

		return (true);
	}

	this.sendDTMF = function (digit) {
		if (this.state != CallState.Active)
			return (false);

		this.session.sendDTMF(digit);

		return (true);
	}

	this.setMute = function (mute) {
		if (this.state != CallState.Active)
			return (false);

		if (mute)
			this.session.mute();
		else
			this.session.unmute();

		return (true);
	}

	this.setHold = function (hold) {
		if (this.state != CallState.Active)
			return (false);

		if (hold)
			this.session.hold();
		else
			this.session.unhold();

		return (true);
	}

	this.sendInfo = function (contentType, body) {
		if (this.state != CallState.Active)
			return (false);

		this.session.sendInfo(contentType, body);

		return (true);
	}

	this._startAudio = function () {
		if (engine.session._connection) {
			engine.session._connection.addEventListener('track', function (e) {
				var view = document.getElementById("remoteAudio");

				view.srcObject = e.streams[0];
				view.play();
			});
		}
	}

	this._userToURI = function (user) {
		var domain;
		if (this.config.domain)
			domain = this.config.domain
		else
			domain = this.config.proxy

		var uri;

		if (user.startsWith("sip:") || user.startsWith("sips:"))
			uri = user;
		else
			uri = "sip:" + user + "@" + domain;

		return (uri);
	}

	this._call_failure = function () {
		engine._setState(CallState.Idle);

		if (engine.config.call_ended)
			engine.config.call_ended();
	}

	this._statUpdate = function () {
		engine.session._connection.getStats(null).then((stats) => {
			stats.forEach((report) => {
				if (report.type == "inbound-rtp") {
					var current = { packetsReceived: report.packetsReceived, packetsLost: report.packetsLost };

					if (engine.inbound_stats) {
						var rx = current.packetsReceived - engine.inbound_stats.packetsReceived;
						var lost = current.packetsLost - engine.inbound_stats.packetsLost;

						if (rx > 0) {
							var loss_pct = (lost / (rx + lost)) * 100;

							if (loss_pct > 5)
								engine._connectivityUpdate(ConnectivityState.Red);
							else if (loss_pct > 0)
								engine._connectivityUpdate(ConnectivityState.Yellow);
							else
								engine._connectivityUpdate(ConnectivityState.Green);
						}
					}

					engine.inbound_stats = current;
				}
			})
		});
	}

	this._connectivityUpdate = function (state) {
		if (this.connectivityState != state) {
			this.connectivityState = state;

			if (engine.config.connectivity_update)
				engine.config.connectivity_update(state);
		}
	}

	this._setState = function (state) {
		engine.state = state;

		if (state == CallState.Idle) {
			clearInterval(engine.statTimer);
			engine.statTimer = undefined;
		}
	}

	this._jss_options = function () {
		var engine = this;

		return (
			{
				'eventHandlers':
				{
					'progress': function (e) {
						if (e.response.status_code == 180 && engine.config.call_ringing)
							engine.config.call_ringing();
					},
					'accepted': function (e) {
					},
					'failed': function (e) {
						if (engine.config.call_failed)
							engine.config.call_failed();
					},
					'confirmed': function (e) {
						if (engine.config.call_connected)
							engine.config.call_connected();
					},
					'ended': function (e) {
						engine._setState(CallState.Idle);

						if (engine.config.call_ended)
							engine.config.call_ended();
					},
					'newInfo': function (e) {
						if (engine.config.info && e.originator == 'remote')
							engine.config.info(e.info);
					}
				},
				'mediaConstraints': { 'audio': true, 'video': false }
			});
	}
}
