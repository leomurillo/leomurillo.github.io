// ==UserScript==
// @name         TOM Feedback System - Truth Obsession Model
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Universal feedback system for capturing user experience with 5-shooting-star ratings
// @author       TOM Team
// @match        *://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const API_ENDPOINT = 'https://api.example.com/tom-feedback'; // Replace with actual endpoint
    const MOCK_MODE = true; // Set to false when using real API

    // Site filters (currently allowing all with *)
    const SITE_FILTERS = ['*']; // Add specific domains like 'amazon.com', 'google.com' etc.

    // Check if current site matches filters
    const currentHost = window.location.hostname;
    const shouldRun = SITE_FILTERS.includes('*') || SITE_FILTERS.some(filter => currentHost.includes(filter));
    
    if (!shouldRun) {
        console.log('[TOM] Site not in filter list, skipping initialization');
        return;
    }

    // Global state
    let feedbackState = {
        isOpen: false,
        rating: 0,
        keyCode: null,
        hierarchy: null,
        selectedPath: [],
        feedbackText: '',
        submitted: false,
        siteAverage: 0,
        pageAverage: 0
    };

    // Inject styles
    GM_addStyle(`
        /* Main container styles */
        #tom-feedback-container {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            color: #333;
            z-index: 999999;
        }

        /* Icon styles */
        #tom-feedback-icon {
            position: fixed;
            width: 48px;
            height: 48px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            cursor: move;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            z-index: 999998;
        }

        #tom-feedback-icon:hover {
            transform: scale(1.1);
            background: rgba(255, 255, 255, 1);
        }

        #tom-feedback-icon.dragging {
            opacity: 0.7;
            cursor: grabbing;
        }

        /* Edge connector line */
        #tom-feedback-connector {
            position: fixed;
            background: #ddd;
            z-index: 999997;
        }

        /* Lightbulb icon SVG */
        #tom-feedback-icon svg {
            width: 28px;
            height: 28px;
        }

        /* Panel styles */
        #tom-feedback-panel {
            position: fixed;
            background: white;
            box-shadow: -2px 0 16px rgba(0, 0, 0, 0.1);
            transition: transform 0.3s ease;
            z-index: 999999;
            overflow-y: auto;
        }

        /* Desktop (right side) */
        @media (min-width: 768px) {
            #tom-feedback-icon {
                right: -24px;
                top: 50%;
                transform: translateY(-50%);
            }
            
            #tom-feedback-connector {
                right: 0;
                top: 50%;
                width: 4px;
                height: 48px;
                transform: translateY(-50%);
            }
            
            #tom-feedback-panel {
                right: 0;
                top: 0;
                width: 360px;
                height: 100vh;
                transform: translateX(100%);
            }
            
            #tom-feedback-panel.open {
                transform: translateX(0);
            }
        }

        /* Mobile (bottom) */
        @media (max-width: 767px) {
            #tom-feedback-icon {
                bottom: -24px;
                left: 50%;
                transform: translateX(-50%);
            }
            
            #tom-feedback-connector {
                bottom: 0;
                left: 50%;
                width: 48px;
                height: 4px;
                transform: translateX(-50%);
            }
            
            #tom-feedback-panel {
                bottom: 0;
                left: 0;
                width: 100%;
                height: 80vh;
                max-height: 600px;
                transform: translateY(100%);
            }
            
            #tom-feedback-panel.open {
                transform: translateY(0);
            }
        }

        /* Panel header */
        .tom-panel-header {
            padding: 20px;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .tom-panel-title {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
        }

        .tom-close-btn {
            width: 32px;
            height: 32px;
            border: none;
            background: #f5f5f5;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }

        .tom-close-btn:hover {
            background: #e0e0e0;
        }

        /* Panel content */
        .tom-panel-content {
            padding: 20px;
        }

        .tom-thank-you {
            font-size: 16px;
            color: #666;
            margin-bottom: 24px;
        }

        /* 5-shooting-star rating */
        .tom-rating-container {
            position: relative;
            width: 290px;
            height: 60px;
            margin: 0 auto 24px;
            cursor: pointer;
        }

        #tom-rating-stars {
            width: 100%;
            height: 100%;
        }

        /* Rating display */
        .tom-rating-display {
            background: #f8f8f8;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 24px;
        }

        .tom-rating-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .tom-rating-row:last-child {
            margin-bottom: 0;
        }

        .tom-rating-label {
            font-weight: 500;
            color: #666;
        }

        .tom-rating-value {
            font-weight: 600;
            color: #1a1a1a;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Improvement section */
        .tom-improvement-title {
            font-size: 16px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 16px;
        }

        /* Tree selector */
        .tom-tree-selector {
            background: #f8f8f8;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            max-height: 200px;
            overflow-y: auto;
        }

        .tom-tree-item {
            padding: 8px 12px;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .tom-tree-item:hover {
            background: #e8e8e8;
        }

        .tom-tree-item.selected {
            background: #ff9900;
            color: white;
        }

        .tom-tree-item.child {
            margin-left: 24px;
        }

        .tom-tree-arrow {
            font-size: 12px;
            transition: transform 0.2s;
        }

        .tom-tree-item.expanded .tom-tree-arrow {
            transform: rotate(90deg);
        }

        /* Text input */
        .tom-text-container {
            margin-bottom: 16px;
        }

        .tom-text-input {
            width: 100%;
            min-height: 100px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 8px;
            resize: vertical;
            font-family: inherit;
            font-size: 14px;
        }

        .tom-text-input:focus {
            outline: none;
            border-color: #ff9900;
        }

        .tom-char-counter {
            text-align: right;
            color: #666;
            font-size: 12px;
            margin-top: 4px;
        }

        /* Submit button */
        .tom-submit-btn {
            width: 100%;
            padding: 14px;
            background: #ff9900;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .tom-submit-btn:hover:not(:disabled) {
            background: #e88800;
        }

        .tom-submit-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Submitted state */
        .tom-homework {
            background: #f0f9ff;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }

        .tom-homework-title {
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 8px;
        }

        .tom-homework-content {
            color: #666;
        }

        .tom-success-message {
            color: #059669;
            font-size: 16px;
            text-align: center;
            margin-bottom: 24px;
        }

        /* Star visualization */
        .tom-star-viz {
            display: inline-flex;
            gap: 4px;
        }

        .tom-star {
            width: 16px;
            height: 16px;
            fill: #ffd700;
        }

        .tom-star.empty {
            fill: #e0e0e0;
        }

        /* Overlay for click-outside */
        #tom-feedback-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.3);
            z-index: 999998;
            display: none;
        }

        #tom-feedback-overlay.active {
            display: block;
        }
    `);

    // Create icon element
    const createIcon = () => {
        const container = document.createElement('div');
        container.id = 'tom-feedback-container';

        const connector = document.createElement('div');
        connector.id = 'tom-feedback-connector';

        const icon = document.createElement('div');
        icon.id = 'tom-feedback-icon';
        icon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C13.1 2 14 2.9 14 4C14 4.4 13.9 4.8 13.7 5.1L16.6 8H18C18.6 8 19 8.4 19 9S18.6 10 18 10H16.6L13.7 12.9C13.9 13.2 14 13.6 14 14C14 15.1 13.1 16 12 16S10 15.1 10 14C10 13.6 10.1 13.2 10.3 12.9L7.4 10H6C5.4 10 5 9.6 5 9S5.4 8 6 8H7.4L10.3 5.1C10.1 4.8 10 4.4 10 4C10 2.9 10.9 2 12 2Z" fill="#ff9900"/>
                <circle cx="12" cy="4" r="3" fill="#FFA500" opacity="0.3"/>
                <path d="M9 21C9 20.4 9.4 20 10 20H14C14.6 20 15 20.4 15 21C15 21.6 14.6 22 14 22H10C9.4 22 9 21.6 9 21Z" fill="#ff9900"/>
                <path d="M7 17C7 16.4 7.4 16 8 16H16C16.6 16 17 16.4 17 17C17 17.6 16.6 18 16 18H8C7.4 18 7 17.6 7 17Z" fill="#ff9900"/>
            </svg>
        `;

        container.appendChild(connector);
        container.appendChild(icon);
        document.body.appendChild(container);

        // Make icon draggable
        makeDraggable(icon);

        // Click handler
        icon.addEventListener('click', togglePanel);
    };

    // Make element draggable
    const makeDraggable = (element) => {
        let isDragging = false;
        let startX, startY, initialX, initialY;

        const startDrag = (e) => {
            isDragging = true;
            element.classList.add('dragging');
            
            const touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX;
            startY = touch.clientY;
            
            const rect = element.getBoundingClientRect();
            initialX = rect.left + rect.width / 2;
            initialY = rect.top + rect.height / 2;
            
            e.preventDefault();
        };

        const drag = (e) => {
            if (!isDragging) return;
            
            const touch = e.touches ? e.touches[0] : e;
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            
            const newX = initialX + deltaX;
            const newY = initialY + deltaY;
            
            // Constrain to viewport
            const maxX = window.innerWidth - 24;
            const maxY = window.innerHeight - 24;
            const constrainedX = Math.max(24, Math.min(newX, maxX));
            const constrainedY = Math.max(24, Math.min(newY, maxY));
            
            element.style.position = 'fixed';
            element.style.left = constrainedX - 24 + 'px';
            element.style.top = constrainedY - 24 + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            element.style.transform = 'none';
            
            e.preventDefault();
        };

        const endDrag = () => {
            isDragging = false;
            element.classList.remove('dragging');
        };

        // Mouse events
        element.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', endDrag);
        
        // Touch events
        element.addEventListener('touchstart', startDrag);
        document.addEventListener('touchmove', drag);
        document.addEventListener('touchend', endDrag);
    };

    // Create feedback panel
    const createPanel = () => {
        const overlay = document.createElement('div');
        overlay.id = 'tom-feedback-overlay';
        
        const panel = document.createElement('div');
        panel.id = 'tom-feedback-panel';
        
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
        
        // Click outside to close
        overlay.addEventListener('click', closePanel);
        
        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && feedbackState.isOpen) {
                closePanel();
            }
        });
        
        renderPanel();
    };

    // Render panel content
    const renderPanel = () => {
        const panel = document.getElementById('tom-feedback-panel');
        
        if (feedbackState.submitted) {
            panel.innerHTML = `
                <div class="tom-panel-header">
                    <h2 class="tom-panel-title">Giving Feedback</h2>
                    <button class="tom-close-btn" onclick="window.tomClosePanel()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="tom-panel-content">
                    <div class="tom-rating-display">
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">You:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.rating)}
                                ${feedbackState.rating.toFixed(1)}
                            </span>
                        </div>
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">Site:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.siteAverage)}
                                ${feedbackState.siteAverage.toFixed(1)}
                            </span>
                        </div>
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">Here:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.pageAverage)}
                                ${feedbackState.pageAverage.toFixed(1)}
                            </span>
                        </div>
                    </div>
                    
                    <div class="tom-homework">
                        <div class="tom-homework-title">Our homework:</div>
                        <div class="tom-homework-content">
                            ${feedbackState.selectedPath.length > 0 ? 
                                `<strong>${feedbackState.selectedPath.join(' > ')}</strong><br>` : ''}
                            ${feedbackState.feedbackText ? 
                                `<p style="margin-top: 8px;">${escapeHtml(feedbackState.feedbackText)}</p>` : ''}
                        </div>
                    </div>
                    
                    <p class="tom-success-message">Thank you! We'll work harder on this.</p>
                    
                    <button class="tom-submit-btn" onclick="window.tomResetFeedback()">
                        Vibe again
                    </button>
                </div>
            `;
        } else if (feedbackState.rating > 0) {
            panel.innerHTML = `
                <div class="tom-panel-header">
                    <h2 class="tom-panel-title">Giving Feedback</h2>
                    <button class="tom-close-btn" onclick="window.tomClosePanel()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="tom-panel-content">
                    <div class="tom-rating-display">
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">You:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.rating)}
                                ${feedbackState.rating.toFixed(1)}
                            </span>
                        </div>
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">Site:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.siteAverage)}
                                ${feedbackState.siteAverage.toFixed(1)}
                            </span>
                        </div>
                        <div class="tom-rating-row">
                            <span class="tom-rating-label">Here:</span>
                            <span class="tom-rating-value">
                                ${renderStars(feedbackState.pageAverage)}
                                ${feedbackState.pageAverage.toFixed(1)}
                            </span>
                        </div>
                    </div>
                    
                    <h3 class="tom-improvement-title">What should we improve the most?</h3>
                    
                    <div class="tom-tree-selector" id="tom-tree-selector">
                        ${renderHierarchy()}
                    </div>
                    
                    <div class="tom-text-container">
                        <textarea 
                            class="tom-text-input" 
                            id="tom-feedback-text"
                            placeholder="Please tell us more (max 1000 chars)"
                            maxlength="1000"
                            oninput="window.tomUpdateCharCount()"
                        >${feedbackState.feedbackText}</textarea>
                        <div class="tom-char-counter" id="tom-char-counter">
                            ${feedbackState.feedbackText.length}/1000
                        </div>
                    </div>
                    
                    <button 
                        class="tom-submit-btn" 
                        id="tom-submit-btn"
                        onclick="window.tomSubmitFeedback()"
                        ${!canSubmit() ? 'disabled' : ''}
                    >
                        Vibe this up!
                    </button>
                </div>
            `;
        } else {
            panel.innerHTML = `
                <div class="tom-panel-header">
                    <h2 class="tom-panel-title">Giving Feedback</h2>
                    <button class="tom-close-btn" onclick="window.tomClosePanel()">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="tom-panel-content">
                    <p class="tom-thank-you">Thank you for helping us get better!</p>
                    
                    <div class="tom-rating-container" id="tom-rating-container">
                        ${render5ShootingStars()}
                    </div>
                </div>
            `;
            
            // Add rating interaction
            setTimeout(() => setupRatingInteraction(), 100);
        }
    };

    // Render 5-shooting-star rating element
    const render5ShootingStars = () => {
        return `
            <svg id="tom-rating-stars" viewBox="-323.6067977 -95.10565163 2118.033989 190.2113033" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <g id="tom-shootingStar">
                        <polygon class="comet" points="-74.89,-22.7 -63.68,0 -74.89,22.7 -323.61,58.78 -292.71,0 -323.61,-58.78" fill="#333" />
                        <polygon class="comet" points="-50,0 -80.9,58.78 -15.45,47.55 30.9,95.11 40.45,29.39 100,0 40.45,-29.39 30.9,-95.11 -15.45,-47.55 -80.9,-58.78" fill="#333" />
                    </g>
                    <mask id="tom-starsMask">
                        <rect class="darkspace" width="2118.033989" height="190.2113033" x="-323.6067977" y="-95.10565163" fill="white" />
                        <use class="comet" href="#tom-shootingStar" fill="black" />
                        <use class="comet" href="#tom-shootingStar" transform="translate(423.6067977, 0)" fill="black" />
                        <use class="comet" href="#tom-shootingStar" transform="translate(847.2135955, 0)" fill="black" />
                        <use class="comet" href="#tom-shootingStar" transform="translate(1270.820393, 0)" fill="black" />
                        <use class="comet" href="#tom-shootingStar" transform="translate(1694.427191, 0)" fill="black" />
                    </mask>
                </defs>
                <rect width="0" height="191" x="-323.61" y="-95.10565163" fill="#ff9900" mask="url(#tom-starsMask)" id="tom-rating-fill" />
                <rect width="2119" height="191" x="-323.61" y="-95.10565163" fill="none" stroke="#ddd" stroke-width="2" />
            </svg>
        `;
    };

    // Setup rating interaction
    const setupRatingInteraction = () => {
        const container = document.getElementById('tom-rating-container');
        const fill = document.getElementById('tom-rating-fill');
        
        if (!container || !fill) return;
        
        const updateRating = (e) => {
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            const fillWidth = percentage * 2119;
            
            fill.setAttribute('width', fillWidth);
            
            // Visual feedback during hover
            if (e.type === 'mousemove') {
                fill.setAttribute('fill', '#ffa500');
            }
        };
        
        const setRating = (e) => {
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            feedbackState.rating = percentage * 5;
            
            console.log('[TOM] Rating set:', feedbackState.rating);
            
            // Submit rating to API
            submitRating();
        };
        
        container.addEventListener('mousemove', updateRating);
        container.addEventListener('click', setRating);
        
        container.addEventListener('mouseleave', () => {
            const fill = document.getElementById('tom-rating-fill');
            if (fill && feedbackState.rating === 0) {
                fill.setAttribute('width', '0');
            }
        });
    };

    // Render star visualization
    const renderStars = (rating) => {
        const fullStars = Math.floor(rating);
        const hasHalf = rating % 1 >= 0.5;
        let html = '<span class="tom-star-viz">';
        
        for (let i = 0; i < 5; i++) {
            if (i < fullStars) {
                html += '<svg class="tom-star" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            } else if (i === fullStars && hasHalf) {
                html += '<svg class="tom-star" viewBox="0 0 24 24"><defs><linearGradient id="half"><stop offset="50%" stop-color="#ffd700"/><stop offset="50%" stop-color="#e0e0e0"/></linearGradient></defs><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="url(#half)"/></svg>';
            } else {
                html += '<svg class="tom-star empty" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            }
        }
        
        html += '</span>';
        return html;
    };

    // Mock hierarchy data
    const mockHierarchy = {
        "Usability": {
            "Navigation": {
                "Search Function": null,
                "Menu Structure": null,
                "Orientation & Wayfinding": null
            },
            "Interface Design": {
                "Visual Design": null,
                "Information Density": null,
                "Interactive Elements": null
            },
            "Workflow & Task Flow": null,
            "Mobile Compatibility": null
        },
        "Content Quality": {
            "Relevance": {
                "Role-Specific Content": null,
                "Information Timeliness": null,
                "Contextual Awareness": null
            },
            "Accuracy & Trustworthiness": null,
            "Completeness": null,
            "Clarity & Comprehension": null
        },
        "Performance": {
            "Speed": {
                "Page Load Time": null,
                "Interaction Response": null,
                "Data Processing Speed": null
            },
            "Reliability": null,
            "System Responsiveness": null
        },
        "Business Value": {
            "Productivity Impact": null,
            "Decision Support": null,
            "Collaboration Support": null
        }
    };

    // Render hierarchy
    const renderHierarchy = () => {
        if (!feedbackState.hierarchy) {
            feedbackState.hierarchy = mockHierarchy;
        }
        
        let html = '';
        const renderNode = (node, path = [], level = 0) => {
            Object.entries(node).forEach(([key, value]) => {
                const currentPath = [...path, key];
                const pathString = currentPath.join('.');
                const isSelected = feedbackState.selectedPath.join('.') === pathString;
                const hasChildren = value && Object.keys(value).length > 0;
                
                html += `
                    <div 
                        class="tom-tree-item ${level > 0 ? 'child' : ''} ${isSelected ? 'selected' : ''}" 
                        style="margin-left: ${level * 24}px"
                        onclick="window.tomSelectHierarchyItem('${pathString}')"
                    >
                        ${hasChildren ? '<span class="tom-tree-arrow">▶</span>' : '<span style="width: 12px; display: inline-block;"></span>'}
                        ${key}
                    </div>
                `;
                
                if (value && isParentSelected(currentPath)) {
                    renderNode(value, currentPath, level + 1);
                }
            });
        };
        
        renderNode(feedbackState.hierarchy);
        return html;
    };

    // Check if parent is selected
    const isParentSelected = (path) => {
        const selected = feedbackState.selectedPath;
        if (selected.length === 0) return true;
        
        for (let i = 0; i < path.length && i < selected.length; i++) {
            if (path[i] !== selected[i]) return false;
        }
        return true;
    };

    // Select hierarchy item
    window.tomSelectHierarchyItem = (pathString) => {
        feedbackState.selectedPath = pathString.split('.');
        renderPanel();
        updateSubmitButton();
    };

    // Update character count
    window.tomUpdateCharCount = () => {
        const textarea = document.getElementById('tom-feedback-text');
        const counter = document.getElementById('tom-char-counter');
        
        if (textarea && counter) {
            feedbackState.feedbackText = textarea.value;
            counter.textContent = `${textarea.value.length}/1000`;
            updateSubmitButton();
        }
    };

    // Update submit button state
    const updateSubmitButton = () => {
        const btn = document.getElementById('tom-submit-btn');
        if (btn) {
            btn.disabled = !canSubmit();
        }
    };

    // Check if can submit
    const canSubmit = () => {
        return feedbackState.selectedPath.length > 0 || feedbackState.feedbackText.trim().length > 0;
    };

    // Submit rating
    const submitRating = async () => {
        console.log('[TOM] Submitting rating:', feedbackState.rating);
        
        const payload = {
            rating: feedbackState.rating,
            url: window.location.href,
            hostname: window.location.hostname,
            pathname: window.location.pathname,
            timestamp: new Date().toISOString()
        };
        
        try {
            const response = await apiCall('/rating', payload);
            feedbackState.keyCode = response.keyCode;
            feedbackState.hierarchy = response.hierarchy || mockHierarchy;
            feedbackState.siteAverage = response.siteAverage || 3.8;
            feedbackState.pageAverage = response.pageAverage || 4.2;
            
            console.log('[TOM] Rating submitted, key code:', feedbackState.keyCode);
            renderPanel();
        } catch (error) {
            console.error('[TOM] Error submitting rating:', error);
        }
    };

    // Submit feedback
    window.tomSubmitFeedback = async () => {
        console.log('[TOM] Submitting feedback:', {
            keyCode: feedbackState.keyCode,
            path: feedbackState.selectedPath,
            text: feedbackState.feedbackText
        });
        
        const payload = {
            keyCode: feedbackState.keyCode,
            hierarchyPath: feedbackState.selectedPath,
            feedbackText: feedbackState.feedbackText,
            timestamp: new Date().toISOString()
        };
        
        try {
            await apiCall('/feedback', payload);
            feedbackState.submitted = true;
            console.log('[TOM] Feedback submitted successfully');
            renderPanel();
        } catch (error) {
            console.error('[TOM] Error submitting feedback:', error);
        }
    };

    // Reset feedback
    window.tomResetFeedback = () => {
        feedbackState = {
            isOpen: true,
            rating: 0,
            keyCode: null,
            hierarchy: null,
            selectedPath: [],
            feedbackText: '',
            submitted: false,
            siteAverage: 0,
            pageAverage: 0
        };
        renderPanel();
    };

    // Toggle panel
    const togglePanel = () => {
        if (feedbackState.isOpen) {
            closePanel();
        } else {
            openPanel();
        }
    };

    // Open panel
    const openPanel = () => {
        feedbackState.isOpen = true;
        const panel = document.getElementById('tom-feedback-panel');
        const overlay = document.getElementById('tom-feedback-overlay');
        
        panel.classList.add('open');
        overlay.classList.add('active');
        
        console.log('[TOM] Panel opened');
    };

    // Close panel
    const closePanel = () => {
        feedbackState.isOpen = false;
        const panel = document.getElementById('tom-feedback-panel');
        const overlay = document.getElementById('tom-feedback-overlay');
        
        panel.classList.remove('open');
        overlay.classList.remove('active');
        
        console.log('[TOM] Panel closed');
    };

    // Global close function
    window.tomClosePanel = closePanel;

    // API call wrapper
    const apiCall = async (endpoint, data) => {
        if (MOCK_MODE) {
            // Mock responses
            console.log('[TOM] Mock API call:', endpoint, data);
            
            if (endpoint === '/rating') {
                return {
                    keyCode: 'MOCK-' + Math.random().toString(36).substr(2, 9),
                    hierarchy: mockHierarchy,
                    siteAverage: 3.5 + Math.random(),
                    pageAverage: 3.8 + Math.random()
                };
            } else if (endpoint === '/feedback') {
                return { success: true };
            }
        }
        
        // Real API call
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_ENDPOINT + endpoint,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(data),
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        resolve(result);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    };

    // Escape HTML
    const escapeHtml = (text) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    };

    // Initialize
    const init = () => {
        console.log('[TOM] Initializing feedback system');
        createIcon();
        createPanel();
        console.log('[TOM] Feedback system ready');
    };

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();