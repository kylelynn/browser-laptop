/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const React = require('react')

const windowActions = require('../actions/windowActions')
const locale = require('../l10n')
const dragTypes = require('../constants/dragTypes')
const messages = require('../constants/messages')
const cx = require('../lib/classSet')
const {getTextColorForBackground} = require('../lib/color')
const {isIntermediateAboutPage} = require('../lib/appUrlUtil')

const contextMenus = require('../contextMenus')
const dnd = require('../dnd')
const windowStore = require('../stores/windowStore')
const ipc = require('electron').ipcRenderer
const throttle = require('../lib/throttle')

const tabStyles = require('../../app/renderer/components/styles/tab')
const {TabIcon, AudioTabIcon} = require('../../app/renderer/components/tabIcon')

class Tab extends React.Component {
  constructor () {
    super()
    this.onMouseEnter = this.onMouseEnter.bind(this)
    this.onMouseLeave = this.onMouseLeave.bind(this)
    this.onUpdateTabSize = this.onUpdateTabSize.bind(this)
    this.state = {
      tabWidth: this.tabSize
    }
  }
  get frame () {
    return windowStore.getFrame(this.props.tab.get('frameKey'))
  }
  get isPinned () {
    return !!this.props.tab.get('pinnedLocation')
  }

  get tabBreakpoint () {
    const tabWidth = this.state.tabWidth

    const medium = tabWidth <= Number.parseInt(tabStyles.breakpoint.medium, 10)
    const small = tabWidth <= Number.parseInt(tabStyles.breakpoint.small, 10)
    const extraSmall = tabWidth <= Number.parseInt(tabStyles.breakpoint.extraSmall, 10)
    const hiddenSecondaryIcon = tabWidth <= Number.parseInt(tabStyles.breakpoint.hiddenSecondaryIcon, 10)
    const faviconOnly = tabWidth <= Number.parseInt(tabStyles.breakpoint.faviconOnly, 10)
    const hiddenFavicon = tabWidth <= Number.parseInt(tabStyles.breakpoint.hiddenFavicon, 10)

    return {
      medium, small, extraSmall, hiddenSecondaryIcon, faviconOnly, hiddenFavicon
    }
  }

  get tabSize () {
    const tab = this.tabNode
    // Avoid TypeError keeping it null until component is mounted
    return tab && !this.isPinned ? tab.getBoundingClientRect().width : null
  }

  get draggingOverData () {
    if (!this.props.draggingOverData ||
        this.props.draggingOverData.get('dragOverKey') !== this.props.tab.get('frameKey')) {
      return
    }

    const sourceDragData = dnd.getInProcessDragData()
    const location = sourceDragData.get('location')
    const key = this.props.draggingOverData.get('dragOverKey')
    const draggingOverFrame = windowStore.getFrame(key)
    if ((location === 'about:blank' || location === 'about:newtab' || isIntermediateAboutPage(location)) &&
        (draggingOverFrame && draggingOverFrame.get('pinnedLocation'))) {
      return
    }

    return this.props.draggingOverData
  }

  onUpdateTabSize () {
    // Avoid calling setState on unmounted component
    // when user switch to a new tabSet
    if (this.tabNode) this.setState({tabWidth: this.tabSize})
  }

  componentWillMount () {
    this.onUpdateTabSize()
  }

  componentDidMount () {
    this.onUpdateTabSize()
    // Execute resize handler at a rate of 15fps
    window.addEventListener('resize', throttle(this.onUpdateTabSize, 66))
  }

  componentWillUnmount () {
    window.removeEventListener('resize', this.onUpdateTabSize)
  }

  get isDragging () {
    const sourceDragData = dnd.getInProcessDragData()
    return sourceDragData && this.props.tab.get('frameKey') === sourceDragData.get('key')
  }

  get isDraggingOverLeft () {
    if (!this.draggingOverData) {
      return false
    }
    return this.draggingOverData.get('draggingOverLeftHalf')
  }

  get isDraggingOverRight () {
    if (!this.draggingOverData) {
      return false
    }
    return this.draggingOverData.get('draggingOverRightHalf')
  }

  get displayValue () {
    // For renderer initiated navigations, make sure we show Untitled
    // until we know what we're loading.  We should probably do this for
    // all about: pages that we already know the title for so we don't have
    // to wait for the title to be parsed.
    if (this.props.tab.get('location') === 'about:blank') {
      return locale.translation('aboutBlankTitle')
    }
    // YouTube tries to change the title to add a play icon when
    // there is audio. Since we have our own audio indicator we get
    // rid of it.
    return (this.props.tab.get('title') ||
      this.props.tab.get('location')).replace('▶ ', '')
  }

  onDragStart (e) {
    dnd.onDragStart(dragTypes.TAB, this.frame, e)
  }

  onDragEnd (e) {
    dnd.onDragEnd(dragTypes.TAB, this.frame, e)
  }

  onDragOver (e) {
    dnd.onDragOver(dragTypes.TAB, this.tabNode.getBoundingClientRect(), this.props.tab.get('frameKey'), this.draggingOverData, e)
  }

  setActiveFrame (event) {
    event.stopPropagation()
    windowActions.setActiveFrame(this.frame)
  }

  onCloseFrame (event) {
    event.stopPropagation()
    windowActions.closeFrame(windowStore.getFrames(), this.frame)
  }

  onMuteFrame (muted, event) {
    event.stopPropagation()
    windowActions.setAudioMuted(this.frame, muted)
  }

  get loading () {
    return this.frame &&
    (this.props.tab.get('loading') ||
     this.props.tab.get('location') === 'about:blank') &&
    (!this.props.tab.get('provisionalLocation') ||
    !this.props.tab.get('provisionalLocation').startsWith('chrome-extension://mnojpmjdmbbfmejpflffifhffcmidifd/'))
  }

  onMouseLeave () {
    window.clearTimeout(this.hoverTimeout)
    windowActions.setPreviewFrame(null)
  }

  onMouseEnter (e) {
    // relatedTarget inside mouseenter checks which element before this event was the pointer on
    // if this element has a tab-like class, then it's likely that the user was previewing
    // a sequency of tabs. Called here as previewMode.
    const previewMode = /tab(?!pages)/i.test(e.relatedTarget.classList)

    // If user isn't in previewMode, we add a bit of delay to avoid tab from flashing out
    // as reported here: https://github.com/brave/browser-laptop/issues/1434
    this.hoverTimeout =
      window.setTimeout(windowActions.setPreviewFrame.bind(null, this.frame), previewMode ? 0 : 200)
  }

  onClickTab (e) {
    // Middle click should close tab
    if (e.button === 1) {
      this.onCloseFrame(e)
    } else {
      this.setActiveFrame(e)
    }
  }

  render () {
    const breakpoint = this.tabBreakpoint
    const narrowView = breakpoint.extraSmall || breakpoint.hiddenSecondaryIcon || breakpoint.faviconOnly || breakpoint.hiddenFavicon
    const secondaryIconIsVisible = !breakpoint.hiddenSecondaryIcon && !breakpoint.faviconOnly && !breakpoint.hiddenFavicon

    let privateIconStyle = narrowView ? {padding: '0'} : null
    let tabIdStyle = narrowView ? {justifyContent: 'center'} : null
    let closeTabStyle = {}

    // Style based on theme-color
    const iconSize = 16
    let iconStyle = {
      minWidth: iconSize,
      width: iconSize
    }
    const activeTabStyle = {}
    const backgroundColor = this.props.paintTabs && (this.props.tab.get('themeColor') || this.props.tab.get('computedThemeColor'))
    if (this.props.isActive && backgroundColor) {
      activeTabStyle.background = backgroundColor
      const textColor = getTextColorForBackground(backgroundColor)
      iconStyle.color = textColor
      if (textColor) {
        activeTabStyle.color = getTextColorForBackground(backgroundColor)
      }
    }

    const locationHasPrivateIcon = !!this.props.tab.get('isPrivate') || !!this.props.tab.get('partitionNumber')

    const icon = this.props.tab.get('icon')
    const defaultIcon = 'fa fa-file-o'

    if (!this.loading && icon) {
      iconStyle = Object.assign(iconStyle, {
        backgroundImage: `url(${icon})`,
        backgroundSize: iconSize,
        height: iconSize
      })
    }

    if (narrowView) {
      closeTabStyle = Object.assign(closeTabStyle, {
        right: '0'
      })
      iconStyle = Object.assign(iconStyle, {
        padding: '0'
      })
    }

    if (breakpoint.faviconOnly && this.props.isActive) {
      Object.assign(closeTabStyle, {
        opacity: '1',
        width: '100%',
        padding: '0',
        backgroundColor: 'white',
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px'
      })
    }

    const playIconExists = !!this.props.tab.get('audioPlaybackActive') || !!this.props.tab.get('audioMuted')

    let playIcon = false
    let iconClass = null
    if (playIconExists) {
      if (this.props.tab.get('audioPlaybackActive') && !this.props.tab.get('audioMuted')) {
        iconClass = 'fa fa-volume-up'
      } else if (this.props.tab.get('audioPlaybackActive') && this.props.tab.get('audioMuted')) {
        iconClass = 'fa fa-volume-off'
      }
      // We don't want playIcon to be shown on small tabs
      playIcon = !narrowView && !(breakpoint.small && locationHasPrivateIcon)
      console.log('nao ta narrow', playIcon)
    }

    const locationHasFavicon = this.props.tab.get('location') !== 'about:newtab'

    const audioPlayNarrowView = playIconExists && ((breakpoint.small && locationHasPrivateIcon) || narrowView)
    const privateIcon = this.props.tab.get('isPrivate') && secondaryIconIsVisible
    const newSessionIcon = this.props.tab.get('partitionNumber') && secondaryIconIsVisible
    const closeTabButton = !this.isPinned && (!breakpoint.faviconOnly && !breakpoint.hiddenFavicon) ||
                            (breakpoint.faviconOnly && this.props.isActive)
    const isHiddenTitle = ((breakpoint.medium || breakpoint.small) && playIconExists && locationHasPrivateIcon) ||
                          (breakpoint.extraSmall && locationHasPrivateIcon) ||
                           breakpoint.faviconOnly || breakpoint.hiddenFavicon

    return <div
      className={cx({
        tabArea: true,
        draggingOverLeft: this.isDraggingOverLeft,
        draggingOverRight: this.isDraggingOverRight,
        isDragging: this.isDragging,
        isPinned: this.isPinned,
        partOfFullPageSet: this.props.partOfFullPageSet
      })}
      onMouseEnter={this.props.previewTabs ? this.onMouseEnter : null}
      onMouseLeave={this.props.previewTabs ? this.onMouseLeave : null}>
      <div className={cx({
        tab: true,
        isPinned: this.isPinned,
        active: this.props.isActive,
        private: this.props.tab.get('isPrivate'),
        noFavicon: !locationHasFavicon,
        alternativePlayIndicator: audioPlayNarrowView
      })}
        data-frame-key={this.props.tab.get('frameKey')}
        ref={(node) => { this.tabNode = node }}
        draggable
        title={this.props.tab.get('title')}
        onDragStart={this.onDragStart.bind(this)}
        onDragEnd={this.onDragEnd.bind(this)}
        onDragOver={this.onDragOver.bind(this)}
        onClick={this.onClickTab.bind(this)}
        onContextMenu={contextMenus.onTabContextMenu.bind(this, this.frame)}
        style={activeTabStyle}>
        <div className='tabId' style={tabIdStyle}>
          {
            (locationHasFavicon && !breakpoint.hiddenFavicon) || this.isPinned
            ? <div className={cx({
              tabIcon: true,
              bookmarkFile: !icon,
              [defaultIcon]: !icon,
              'fa fa-circle-o-notch fa-spin': this.loading
            })}
              style={iconStyle} />
            : null
          }
          {
            !this.isPinned && !isHiddenTitle
            ? <div className='tabTitle'>
              {this.displayValue}
            </div>
            : null
          }
          {
            playIcon
            ? <AudioTabIcon styles={iconClass}
              onClick={this.onMuteFrame.bind(this, !this.props.tab.get('audioMuted'))} />
            : null
          }
        </div>
        {
          privateIcon
          ? <TabIcon styles='fa fa-eye' style={privateIconStyle} />
          : null
        }
        {
          newSessionIcon
          ? <TabIcon l10nArgs={JSON.stringify({partitionNumber: this.props.tab.get('partitionNumber')})}
            l10nId='sessionInfoTab'
            styles='fa fa-user'
            style={privateIconStyle} />
          : null
        }
        {
          closeTabButton
          ? <span onClick={this.onCloseFrame.bind(this)}
            data-l10n-id='closeTabButton'
            className='closeTab fa fa-times-circle'
            style={closeTabStyle} />
          : null
        }
      </div>
    </div>
  }
}

const paymentsEnabled = () => {
  const getSetting = require('../settings').getSetting
  const settings = require('../constants/settings')
  return getSetting(settings.PAYMENTS_ENABLED)
}

windowStore.addChangeListener(() => {
  if (paymentsEnabled()) {
    const windowState = windowStore.getState()
    const tabs = windowState && windowState.get('tabs')
    if (tabs) {
      try {
        const presentP = tabs.some((tab) => {
          return tab.get('location') === 'about:preferences#payments'
        })
        ipc.send(messages.LEDGER_PAYMENTS_PRESENT, presentP)
      } catch (ex) { }
    }
  }
})
module.exports = Tab
