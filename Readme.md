# gRPC-Web DevTools Extension

## ✨ Core Functionality

This Chrome DevTools extension provides comprehensive inspection and debugging capabilities for gRPC-Web traffic directly within the browser environment.

### Key Features:

- **Real-time request interception** - Captures all gRPC-Web requests made by your application without requiring code modifications
- **Detailed request/response inspection** - View method names, request parameters, responses, and error details in structured format
- **Advanced search functionality** - Search through all request/response data with visual highlighting of matches
- **Navigation between results** - Easily move between matching search results using next/previous buttons
- **Support for multiple gRPC-Web implementations** - Works with both unary and streaming requests from various gRPC-Web libraries
- **Automatic request serialization** - Handles complex data structures and circular references safely

## 🛠 Technical Architecture

The extension employs a sophisticated multi-layer architecture to capture and display gRPC-Web traffic:

### 1. Content Script Interception Layer

- Injects specialized interceptors (`grpc-web-inject.js` and `connect-web-interceptor.js`) into the page context
- Captures gRPC-Web requests at the JavaScript level before they're sent to the network
- Handles both unary and streaming request types
- Sanitizes data to prevent serialization issues with circular references

### 2. Communication Infrastructure

- Uses Chrome's port API for reliable message passing between components
- Implements automatic reconnection logic to handle service worker lifecycle events
- Handles the Back/Forward Cache (BFCache) transitions gracefully
- Prevents data loss during temporary connection interruptions

### 3. Data Processing Pipeline

- Implements robust data sanitization to handle unserializable objects:
  ```javascript
  function sanitizeForSerialization(obj) {
    // Handles circular references and complex structures
    // Returns safe representation for messaging
  }
  ```
- Maintains request history with automatic rotation (keeps last 100 requests)
- Filters requests based on search criteria with substring matching
- Preserves selected request state during filtering operations

### 4. Search and Highlighting System

- Implements multi-layer highlighting:
  - Request list items
  - Request details (method, parameters)
  - Response data
  - Error information
- Tracks current search result position with visual indicator
- Handles empty search states appropriately
- Maintains search context during request selection

## 🌐 How It Works

The extension operates through a coordinated system of components:

1. **Content Scripts Injection**:
   - When a page loads, the extension injects interceptors that wrap gRPC-Web client methods
   - These interceptors capture request/response data before transmission

2. **Data Capture Process**:
   ```mermaid
   graph LR
   A[gRPC-Web Call] --> B(Interceptors)
   B --> C{Capture Request Data}
   C --> D[Sanitize Data]
   D --> E[Send via Port]
   E --> F[Background Service Worker]
   F --> G[DevTools Panel]
   ```

3. **Message Flow**:
   - gRPC calls trigger interceptors in the page context
   - Interceptors capture request/response data
   - Data is sanitized and sent through a persistent port connection
   - Background service worker routes messages to DevTools panel
   - Panel renders requests with appropriate filtering and highlighting

4. **Search Implementation**:
   - Search operates on serialized request/response data
   - Highlights matches in both the request list and details panel
   - Maintains navigation state between search results
   - Automatically selects first matching request when search term changes

5. **State Management**:
   - Maintains selected request state independently from search filters
   - Handles transitions between filtered and unfiltered states
   - Preserves search context during request selection
   - Implements proper cleanup of resources when DevTools panel is closed

## 🔒 Data Security

- All captured data remains within the browser
- No external network requests are made by the extension
- Request data is sanitized to prevent execution of malicious content
- Limited storage of request history (100 requests maximum)
- Automatic cleanup of resources when DevTools panel is closed

This extension provides a powerful debugging tool for gRPC-Web applications while maintaining a secure, self-contained architecture that operates entirely within the browser environment.

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.