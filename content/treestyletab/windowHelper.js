Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this,
  'TreeStyleTabUtils', 'resource://treestyletab-modules/utils.js');

var TreeStyleTabWindowHelper = { 
	runningDelayedStartup : false,
	
	get service() 
	{
		return TreeStyleTabService;
	},
 
	preInit : function TSTWH_preInit() 
	{
		gBrowserInit.__treestyletab___delayedStartup = gBrowserInit._delayedStartup;
		gBrowserInit._delayedStartup = function(...args) {
			TreeStyleTabWindowHelper.runningDelayedStartup = true;
			var retVal = this.__treestyletab___delayedStartup.apply(this, args);
			TreeStyleTabWindowHelper.runningDelayedStartup = false;
			return retVal;
		};

		nsBrowserAccess.prototype.__treestyletab__openURI = nsBrowserAccess.prototype.openURI;
		nsBrowserAccess.prototype.openURI = function(aURI, aOpener, aWhere, aContext) {
			var where = aWhere;
			if (where === Ci.nsIBrowserDOMWindow.OPEN_DEFAULTWINDOW) {
				let isExternal = aContext === Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL;
				let overridePref = TreeStyleTabUtils.prefs.getPref('browser.link.open_newwindow.override.external');
				if (isExternal && overridePref !== null)
					where = overridePref;
				else
					where = TreeStyleTabUtils.prefs.getPref('browser.link.open_newwindow');
			}
			TreeStyleTabService.onBeforeBrowserAccessOpenURI(aOpener, where, aContext);
			return this.__treestyletab__openURI.call(this, aURI, aOpener, aWhere, aContext);
		};

		nsBrowserAccess.prototype.__treestyletab__openURIInFrame = nsBrowserAccess.prototype.openURIInFrame;
		nsBrowserAccess.prototype.openURIInFrame = function(aURI, aParams, aWhere, aContext) {
			if (aWhere === Ci.nsIBrowserDOMWindow.OPEN_NEWTAB)
				TreeStyleTabService.onBeforeBrowserAccessOpenURI(aParams, aWhere, aContext);
			return this.__treestyletab__openURIInFrame.call(this, aURI, aParams, aWhere, aContext);
		};

		if ('TabsInTitlebar' in window) {
			TreeStyleTabUtils.doPatching(TabsInTitlebar._update, 'TabsInTitlebar._update', function(aName, aSource) {
				return eval(aName+' = '+aSource.replace(
					/let fullTabsHeight = /,
					'$& gBrowser.treeStyleTab.position != "top" ? 0 : '
				));
			}, 'treeStyleTab');
		}

		window.__treestyletab__BrowserOpenTab = window.BrowserOpenTab;
		window.BrowserOpenTab = function(...aArgs) {
			gBrowser.treeStyleTab.onBeforeNewTabCommand();
			return this.__treestyletab__BrowserOpenTab.apply(this, aArgs);
		};

		window.__treestyletab__undoCloseTab = window.undoCloseTab;
		window.undoCloseTab = function(...aArgs) {
			gBrowser.__treestyletab__doingUndoCloseTab = true;
			var tab = this.__treestyletab__undoCloseTab.apply(this, aArgs);
			if (tab)
				tab.__treestyletab__restoredByUndoCloseTab = true;
			setTimeout(function() {
				delete gBrowser.__treestyletab__doingUndoCloseTab;
			}, 0);
			return tab;
		};

		[
			'window.duplicateTab.handleLinkClick',
			'window.duplicatethistab.handleLinkClick',
			'window.__treestyletab__highlander__origHandleLinkClick',
			'window.__splitbrowser__handleLinkClick',
			'window.__ctxextensions__handleLinkClick',
			'window.handleLinkClick'
		].some(function(aName) {
			let func = this._getFunction(aName);
			if (!func || !/^\(?function handleLinkClick/.test(func.toString()))
				return false;
			TreeStyleTabUtils.doPatching(func, aName, function(aName, aSource) {
				return eval(aName+' = '+aSource.replace(
					/(charset\s*:\s*doc\.characterSet\s*)/,
					'$1, event : event, linkNode : linkNode'
				));
			}, 'event : event, linkNode : linkNode');
			return true;
		}, this);

		this.overrideExtensionsPreInit(); // windowHelperHacks.js
	},
 
	onBeforeBrowserInit : function TSTWH_onBeforeBrowserInit() 
	{
		this.overrideExtensionsBeforeBrowserInit(); // windowHelperHacks.js
		this.overrideGlobalFunctions();

		// Replacing of gBrowserInit._delayedStartup() with eval()
		// breaks the variable scope of the function and break its
		// functionality completely.
		// Instead, I change the behavior of the method only at the
		// startup process.
		gBrowser.__treestyletab__swapBrowsersAndCloseOther = gBrowser.swapBrowsersAndCloseOther;
		gBrowser.swapBrowsersAndCloseOther = function(...args) {
			if (TreeStyleTabWindowHelper.runningDelayedStartup &&
				TreeStyleTabService.tearOffSubtreeFromRemote())
				return;
			return this.__treestyletab__swapBrowsersAndCloseOther.apply(this, args);
		};
	},
 
	onAfterBrowserInit : function TSTWH_onAfterBrowserInit() 
	{
		this.overrideExtensionsAfterBrowserInit(); // windowHelperHacks.js
	},
	
	updateTabDNDObserver : function TSTWH_updateTabDNDObserver(aObserver) 
	{
		var strip = this.service.getTabStrip(aObserver) ||
					gBrowser.mStrip // fallback to the default strip, for Tab Mix Plus;

		if (
			aObserver.tabContainer &&
			aObserver.tabContainer.tabbrowser == aObserver
			)
			aObserver = aObserver.tabContainer;

		if (typeof aObserver._setEffectAllowedForDataTransfer === 'function') { // Firefox 43 and older
			TreeStyleTabUtils.doPatching(aObserver._setEffectAllowedForDataTransfer, aObserver+'._setEffectAllowedForDataTransfer', function(aName, aSource) {
				return eval('aObserver._setEffectAllowedForDataTransfer = '+aSource.replace(
					'{',
					'{ var TSTTabBrowser = this instanceof Element ? (this.tabbrowser || this) : gBrowser ; var TST = TSTTabBrowser.treeStyleTab;'
				).replace(
					/\.screenX/g, '[TST.screenPositionProp]'
				).replace(
					/\.width/g, '[TST.sizeProp]'
				).replace(
					/(return (?:true|dt.effectAllowed = "copyMove");)/,
					'if (!TST.tabbarDNDObserver.canDropTab(arguments[0])) {\n' +
					'  return dt.effectAllowed = "none";\n' +
					'}\n' +
					'$1'
				).replace(
					'sourceNode.parentNode == this &&',
					'$& TST.getTabFromEvent(event) == sourceNode &&'
				));
			}, 'TST');
		}
		else { // Firefox 44 and later
			aObserver.__treestyletab__getDropEffectForTabDrag = aObserver._getDropEffectForTabDrag;
			aObserver._getDropEffectForTabDrag = function(...aArgs) {
				var effects = this.__treestyletab__getDropEffectForTabDrag.apply(this, aArgs);
				if (effects === 'copy' || effects === 'move') {
					let TSTTabBrowser = this instanceof Element ? (this.tabbrowser || this) : gBrowser ;
					var TST = TSTTabBrowser.treeStyleTab
					if (!TST.tabbarDNDObserver.canDropTab(aArgs[0]))
						effects = 'none';
				}
				return effects;
			};
		}
	},
 
	overrideGlobalFunctions : function TSTWH_overrideGlobalFunctions() 
	{
		this.initToolbarItems();

		nsContextMenu.prototype.__treestyletab__openLinkInTab = nsContextMenu.prototype.openLinkInTab;
		nsContextMenu.prototype.openLinkInTab = function(...aArgs) {
			TreeStyleTabService.handleNewTabFromCurrent(this.target.ownerDocument.defaultView);
			return this.__treestyletab__openLinkInTab.apply(this, aArgs);
		};

		nsContextMenu.prototype.__treestyletab__openFrameInTab = nsContextMenu.prototype.openFrameInTab;
		nsContextMenu.prototype.openFrameInTab = function(...aArgs) {
			TreeStyleTabService.handleNewTabFromCurrent(this.target.ownerDocument.defaultView);
			return this.__treestyletab__openFrameInTab.apply(this, aArgs);
		};

		nsContextMenu.prototype.__treestyletab__viewMedia = nsContextMenu.prototype.viewMedia;
		nsContextMenu.prototype.viewMedia = function(aEvent) {
			TreeStyleTabService.onBeforeViewMedia(aEvent, this.target.ownerDocument.defaultView);
			return this.__treestyletab__viewMedia.call(this, aEvent);
		};

		nsContextMenu.prototype.__treestyletab__viewBGImage = nsContextMenu.prototype.viewBGImage;
		nsContextMenu.prototype.viewBGImage = function(aEvent) {
			TreeStyleTabService.onBeforeViewMedia(aEvent, this.target.ownerDocument.defaultView);
			return this.__treestyletab__viewBGImage.call(this, aEvent);
		};

		nsContextMenu.prototype.__treestyletab__addDictionaries = nsContextMenu.prototype.addDictionaries;
		nsContextMenu.prototype.addDictionaries = function() {
			var newWindowPref = TreeStyleTabUtils.prefs.getPref('browser.link.open_newwindow');
			var where = newWindowPref === 3 ? 'tab' : 'window' ;
			TreeStyleTabService.onBeforeOpenLink(where, this.target.ownerDocument.defaultView);
			return this.__treestyletab__addDictionaries.call(this, aEvent);
		};

		BrowserSearch.__treestyletab__loadSearch = BrowserSearch._loadSearch;
		BrowserSearch._loadSearch = function(aSearchText, aUseNewTab, aPurpose) {
			TreeStyleTabService.onBeforeBrowserSearch(aSearchText, aUseNewTab);
			return this.__treestyletab__loadSearch.call(this, aEvent);
		};

		window.__treestyletab__openLinkIn = window.openLinkIn;
		window.openLinkIn = function(aUrl, aWhere, aParams) {
			TreeStyleTabService.onBeforeOpenLinkWithTab(gBrowser.selectedTab, aParams.fromChrome);
			return this.__treestyletab__openLinkIn.call(this, aUrl, aWhere, aParams);
		};

		[
			{ owner: window.permaTabs && window.permaTabs.utils && window.permaTabs.utils.wrappedFunctions,
			  name:  'window.contentAreaClick' },
			{ owner: window,
			  name:  '__contentAreaClick' },
			{ owner: window,
			  name:  '__ctxextensions__contentAreaClick' },
			{ owner: window,
			  name:  'contentAreaClick' }
		].forEach(function(aTarget) {
			var name = aTarget.name;
			var owner = aTarget.owner;
			var func = owner && owner[name];
			var source = func && func.toString();
			if (!func ||
				!/^\(?function contentAreaClick/.test(source) ||
				// for Tab Utilities, etc. Some addons insert openNewTabWith() to the function.
				// (calls for the function is not included by Firefox default.)
				!/(openNewTabWith\()/.test(source))
				return;
			let original = '__treestyletab__' + name;
			owner[original] = owner[name];
			owner[name] = function(aEvent, aIsPanelClick, ...aArgs) {
				TreeStyleTabService.onBeforeOpenNewTabByThirdParty(aEvent.target.ownerDocument.defaultView);
				return this[original].apply(this, [aEvent, aIsPanelClick].concat(aArgs));
			};
		}, this);

		window.__treestyletab__duplicateTabIn = window.duplicateTabIn;
		window.duplicateTabIn = function(aTab, where, delta) {
			gBrowser.treeStyleTab.onBeforeTabDuplicate(aTab, where, delta);
			return window.__treestyletab__duplicateTabIn.call(this, aTab, where, delta);
		};

		[
			'permaTabs.utils.wrappedFunctions["window.BrowserHomeClick"]',
			'window.BrowserHomeClick',
			'window.BrowserGoHome'
		].forEach(function(aName) {
			let func = this._getFunction(aName);
			if (!func || !/^\(?function (BrowserHomeClick|BrowserGoHome)/.test(func.toString()))
				return;
			TreeStyleTabUtils.doPatching(func, aName, function(aName, aSource) {
				return eval(aName+' = '+aSource.replace(
					'gBrowser.loadTabs(',
					'TreeStyleTabService.readyToOpenNewTabGroup(gBrowser); $&'
				));
			}, 'TreeStyleTab');
		}, this);

		FeedHandler.__treestyletab__loadFeed = FeedHandler.loadFeed;
		FeedHandler.loadFeed = function(aHref, aEvent) {
			TreeStyleTabService.onBeforeViewMedia(aEvent, gBrowser);
			return this.__treestyletab__loadFeed.call(this, aHref, aEvent);
		};

		if ('showNavToolbox' in FullScreen) { // for Firefox 40 or later
			FullScreen.__treestyletab__showNavToolbox = FullScreen.showNavToolbox;
			FullScreen.showNavToolbox = function(...aArgs) {
				var beforeCollapsed = this._isChromeCollapsed;
				var retVal = this.__treestyletab__showNavToolbox.apply(this, aArgs);
				if (beforeCollapsed !== this._isChromeCollapsed)
					gBrowser.treeStyleTab.updateFloatingTabbar(gBrowser.treeStyleTab.kTABBAR_UPDATE_BY_FULLSCREEN);
				return retVal;
			};

			FullScreen.__treestyletab__hideNavToolbox = FullScreen.hideNavToolbox;
			FullScreen.hideNavToolbox = function(...aArgs) {
				var beforeCollapsed = this._isChromeCollapsed;
				var retVal = this.__treestyletab__hideNavToolbox.apply(this, aArgs);
				if (beforeCollapsed !== this._isChromeCollapsed)
					gBrowser.treeStyleTab.updateFloatingTabbar(gBrowser.treeStyleTab.kTABBAR_UPDATE_BY_FULLSCREEN);
				return retVal;
			};
		}
		else if ('mouseoverToggle' in FullScreen) { // for Firefox 39 or older
			FullScreen.__treestyletab__mouseoverToggle = FullScreen.mouseoverToggle;
			FullScreen.mouseoverToggle = function(...aArgs) {
				var beforeCollapsed = this._isChromeCollapsed;
				var retVal = this.__treestyletab__mouseoverToggle.apply(this, aArgs);
				if (beforeCollapsed !== this._isChromeCollapsed)
					gBrowser.treeStyleTab.updateFloatingTabbar(gBrowser.treeStyleTab.kTABBAR_UPDATE_BY_FULLSCREEN);
				return retVal;
			};
		}

		FullScreen.__treestyletab__toggle = FullScreen.toggle;
		FullScreen.toggle = function(...aArgs) {
			var enterFS = window.fullScreen;
			gBrowser.treeStyleTab.onBeforeFullScreenToggle(enterFS);
			return this.__treestyletab__toggle.apply(this, aArgs);
		};

		PrintUtils.__treestyletab__printPreview = PrintUtils.printPreview;
		PrintUtils.printPreview = function(...aArgs) {
			TreeStyleTabService.onPrintPreviewEnter();
			return this.__treestyletab__printPreview.apply(this, aArgs);
		};
		PrintUtils.__treestyletab__exitPrintPreview = PrintUtils.exitPrintPreview;
		PrintUtils.exitPrintPreview = function(...aArgs) {
			TreeStyleTabService.onPrintPreviewExit();
			return this.__treestyletab__exitPrintPreview.apply(this, aArgs);
		};

		SidebarUI.__treestyletab__show = SidebarUI.show;
		SidebarUI.show = function(...aArgs) {
			var opened = this.isOpen;
			var width = this.browser.boxObject.width;
			return this.__treestyletab__show.apply(this, aArgs)
					.then((function(aResult) {
						if (opened !== this.isOpen ||
							width !== this.browser.boxObject.width)
							gBrowser.treeStyleTab.updateFloatingTabbar(gBrowser.treeStyleTab.kTABBAR_UPDATE_BY_TOGGLE_SIDEBAR);
						return aResult;
					}).bind(this));
		};
		SidebarUI.__treestyletab__hide = SidebarUI.hide;
		SidebarUI.hide = function(...aArgs) {
			var opened = this.isOpen;
			var width = this.browser.boxObject.width;
			var retVal = this.__treestyletab__hide.apply(this, aArgs);
			if (opened !== this.isOpen ||
				width !== this.browser.boxObject.width)
				gBrowser.treeStyleTab.updateFloatingTabbar(gBrowser.treeStyleTab.kTABBAR_UPDATE_BY_TOGGLE_SIDEBAR);
			return retVal;
		};
	},
	_splitFunctionNames : function TSTWH__splitFunctionNames(aString)
	{
		return String(aString)
				.split(/\s+/)
				.map(function(aString) {
					return aString
							.replace(/\/\*.*\*\//g, '')
							.replace(/\/\/.+$/, '')
							.trim();
				});
	},
	_getFunction : function TSTWH__getFunction(aFunc)
	{
		var func;
		try {
			eval('func = '+aFunc);
		}
		catch(e) {
			return null;
		}
		return func;
	},
 
	initToolbarItems : function TSTWH_initToolbarItems() 
	{
		var searchbar = document.getElementById('searchbar');
		if (searchbar &&
			searchbar.doSearch &&
			!searchbar.__treestyletab__original_doSearch) {
			searchbar.__treestyletab__original_doSearch = searchbar.doSearch;
			searchbar.doSearch = function(...aArgs) {
				TreeStyleTabService.onBeforeBrowserSearch(aArgs[0]);
				var retVal = this.__treestyletab__original_doSearch.apply(this, aArgs);
				TreeStyleTabService.stopToOpenChildTab();
				return retVal;
			};
		}

		var goButton = document.getElementById('urlbar-go-button');
		if (goButton)
			goButton.parentNode.addEventListener('click', this.service, true);

		var tabbar = this.service.getTabStrip(this.service.browser);
		tabbar.addEventListener('click', this.service, true);

		var newTabButton = document.getElementById('new-tab-button');
		var nsIDOMNode = Ci.nsIDOMNode;
		if (newTabButton &&
			!(tabbar.compareDocumentPosition(newTabButton) & nsIDOMNode.DOCUMENT_POSITION_CONTAINED_BY))
			newTabButton.parentNode.addEventListener('click', this.service, true);

		this.service.updateAllTabsButton(gBrowser);
	},
 
	destroyToolbarItems : function TSTWH_destroyToolbarItems() 
	{
		var goButton = document.getElementById('urlbar-go-button');
		if (goButton)
			goButton.parentNode.removeEventListener('click', this, true);

		var tabbar = this.service.getTabStrip(this.service.browser);
		tabbar.removeEventListener('click', this.service, true);

		var newTabButton = document.getElementById('new-tab-button');
		var nsIDOMNode = Ci.nsIDOMNode;
		if (newTabButton &&
			!(tabbar.compareDocumentPosition(newTabButton) & Ci.nsIDOMNode.DOCUMENT_POSITION_CONTAINED_BY))
			newTabButton.parentNode.removeEventListener('click', this.service, true);

		var allTabsButton = document.getElementById('alltabs-button');
		if (allTabsButton && allTabsButton.hasChildNodes())
			allTabsButton.firstChild.setAttribute('position', 'after_end');
	},
  
	initTabbrowserMethods : function TSTWH_initTabbrowserMethods(aTabBrowser) 
	{
		var b = aTabBrowser;

		TreeStyleTabUtils.doPatching(b.moveTabForward, 'b.moveTabForward', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				'if (nextTab)',
				'(function() {\n' +
				'  if (this.treeStyleTab.hasChildTabs(this.mCurrentTab)) {\n' +
				'    let descendant = this.treeStyleTab.getDescendantTabs(this.mCurrentTab);\n' +
				'    if (descendant.length)\n' +
				'      nextTab = this.treeStyleTab.getNextTab(descendant[descendant.length-1]);\n' +
				'  }\n' +
				'}).call(this);' +
				'$&'
			).replace(
				/(this.moveTabTo\([^;]+\);)/,
				'(function() {\n' +
				'  let descendant = this.treeStyleTab.getDescendantTabs(nextTab);\n' +
				'  if (descendant.length) {\n' +
				'    nextTab = descendant[descendant.length-1];\n' +
				'  }\n' +
				'  $1\n' +
				'}).call(this);'
			).replace(
				'this.moveTabToStart();',
				'(function() {\n' +
				'  this.treeStyleTab.internallyTabMovingCount++;\n' +
				'  let parentTab = this.treeStyleTab.getParentTab(this.mCurrentTab);\n' +
				'  if (parentTab) {\n' +
				'    this.moveTabTo(this.mCurrentTab, this.treeStyleTab.getFirstChildTab(parentTab)._tPos);\n' +
				'    this.mCurrentTab.focus();\n' +
				'  }\n' +
				'  else {\n' +
				'    $&\n' +
				'  }\n' +
				'  this.treeStyleTab.internallyTabMovingCount--;\n' +
				'}).call(this);'
			));
		}, 'treeStyleTab');

		TreeStyleTabUtils.doPatching(b.moveTabBackward, 'b.moveTabBackward', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				'this.moveTabToEnd();',
				'(function() {\n' +
				'  this.treeStyleTab.internallyTabMovingCount++;\n' +
				'  let parentTab = this.treeStyleTab.getParentTab(this.mCurrentTab);\n' +
				'  if (parentTab) {\n' +
				'    this.moveTabTo(this.mCurrentTab, this.treeStyleTab.getLastChildTab(parentTab)._tPos);\n' +
				'    this.mCurrentTab.focus();\n' +
				'  }\n' +
				'  else {\n' +
				'    $&\n' +
				'  }\n' +
				'  this.treeStyleTab.internallyTabMovingCount--;\n' +
				'}).call(this);'
			));
		}, 'treeStyleTab');

		TreeStyleTabUtils.doPatching(b.loadTabs, 'b.loadTabs', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				'var tabNum = ',
				'if (this.treeStyleTab.readiedToAttachNewTabGroup)\n' +
				'  TreeStyleTabService.readyToOpenChildTab(firstTabAdded || this.selectedTab, true);\n' +
				'$&'
			).replace(
				'if (!aLoadInBackground)',
				'if (TreeStyleTabService.checkToOpenChildTab(this))\n' +
				'  TreeStyleTabService.stopToOpenChildTab(this);\n' +
				'$&'
			).replace(
				'this.selectedTab = firstTabAdded;',
				'this.selectedTab = aURIs[0].indexOf("about:treestyletab-group") < 0 ? \n' +
				'  firstTabAdded :\n' +
				'  TreeStyleTabService.getNextTab(firstTabAdded) ;'
			));
		}, 'TreeStyleTab');

		TreeStyleTabUtils.doPatching(b._beginRemoveTab, 'b._beginRemoveTab', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				'if (this.tabs.length - this._removingTabs.length == 1) {',
				'if (this.tabs.length - this._removingTabs.length == 1 || this.treeStyleTab.shouldCloseLastTabSubtreeOf(aTab)) {'
			).replace(
				'this._removingTabs.length == 0',
				'(this.treeStyleTab.shouldCloseLastTabSubtreeOf(aTab) || $&)'
			));
		}, 'treeStyleTab');

		b.__treestyletab__removeCurrentTab = b.removeCurrentTab;
		b.removeCurrentTab = function(...aArgs) {
			if (!this.treeStyleTab.warnAboutClosingTabSubtreeOf(this.selectedTab))
				return;
			return this.__treestyletab__removeCurrentTab.apply(this, aArgs);
		};
	},
 
	initTabbarMethods : function TSTWH_initTabbarMethods(aTabBrowser) 
	{
		var b = aTabBrowser;

		b.mTabContainer.__treestyletab__advanceSelectedTab = b.mTabContainer.advanceSelectedTab;
		b.mTabContainer.advanceSelectedTab = function(...aArgs) {
			var treeStyleTab = TreeStyleTabService.getTabBrowserFromChild(this).treeStyleTab;
			if (treeStyleTab.handleAdvanceSelectedTab(aArgs[0], aArgs[1]))
				return;
			return this.__treestyletab__advanceSelectedTab.apply(this, aArgs);
		};

		TreeStyleTabUtils.doPatching(b.mTabContainer._notifyBackgroundTab, 'b.mTabContainer._notifyBackgroundTab', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				'{',
				'{\n' +
				'  var treeStyleTab = TreeStyleTabService.getTabBrowserFromChild(this).treeStyleTab;\n' +
				'  if (treeStyleTab.scrollToNewTabMode == 0 ||\n' +
				'      treeStyleTab.shouldCancelEnsureElementIsVisible())\n' +
				'    return;'
			).replace(
				/\.screenX/g, '[treeStyleTab.screenPositionProp]'
			).replace(
				/\.width/g, '[treeStyleTab.sizeProp]'
			).replace(
				/\.left/g, '[treeStyleTab.startProp]'
			).replace(
				/\.right/g, '[treeStyleTab.endProp]'

			// replace such codes:
			//   tab = {left: tab.left, right: tab.right};
			).replace(
				/left\s*:/g, 'start:'
			).replace(
				/right\s*:/g, 'end:'
			).replace(
				/((tab|selected)\s*=\s*\{\s*start:[^\}]+\})/g,
				'$1; $2[treeStyleTab.startProp] = $2.start; $2[treeStyleTab.endProp] = $2.end;'

			).replace(
				'!selected ||',
				'$& treeStyleTab.scrollToNewTabMode == 1 && '
			).replace(
				/(\}\)?)$/,
				'treeStyleTab.notifyBackgroundTab(); $1'
			));
		}, 'TreeStyleTabService.getTabBrowserFromChild');

		TreeStyleTabUtils.doPatching(b.tabContainer._getDragTargetTab, 'b.tabContainer._getDragTargetTab', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				/\.screenX/g, '[this.treeStyleTab.screenPositionProp]'
			).replace(
				/\.width/g, '[this.treeStyleTab.sizeProp]'
			));
		}, 'treeStyleTab');

		TreeStyleTabUtils.doPatching(b.tabContainer._getDropIndex, 'b.tabContainer._getDropIndex', function(aName, aSource) {
			return eval(aName+' = '+aSource.replace(
				/\.screenX/g, '[this.treeStyleTab.screenPositionProp]'
			).replace(
				/\.width/g, '[this.treeStyleTab.sizeProp]'
			));
		}, 'treeStyleTab');

		/**
		 * The default implementation fails to scroll to tab if it is expanding.
		 * So we have to override its effect.
		 */
		{
			let scrollbox = aTabBrowser.treeStyleTab.scrollBox;
				if (!scrollbox.__treestyletab__ensureElementIsVisible) {
				scrollbox.__treestyletab__ensureElementIsVisible = scrollbox.ensureElementIsVisible;
				scrollbox.ensureElementIsVisible = function(...aArgs) {
					var treeStyleTab = TreeStyleTabService.getTabBrowserFromChild(this).treeStyleTab;
					if (treeStyleTab) {
						if (treeStyleTab.shouldCancelEnsureElementIsVisible())
							return;
						let shouldScrollNow = aArgs[1] === false;
						if (treeStyleTab.animationEnabled && !shouldScrollNow)
							return treeStyleTab.scrollToTab(aArgs[0]);
					}
					this.__treestyletab__ensureElementIsVisible.apply(this, aArgs);
				};
			}
		}

		{
			let popup = document.getElementById('alltabs-popup');
			TreeStyleTabUtils.doPatching(popup._updateTabsVisibilityStatus, 'popup._updateTabsVisibilityStatus', function(aName, aSource) {
				return eval(aName+' = '+aSource.replace(
					'{',
					'{ var treeStyleTab = gBrowser.treeStyleTab;'
				).replace(
					/\.screenX/g, '[treeStyleTab.screenPositionProp]'
				).replace(
					/\.width/g, '[treeStyleTab.sizeProp]'
				));
			}, 'treeStyleTab');
		}
	
	}
 
}; 
  
