```mermaid
sequenceDiagram
    participant Resumable as ArvoResumable.execute
    participant Agent as ArvoAgent Handler
    participant Context as Context Builder
    participant CoreLoop as Agent Core Loop
    participant PermMgr as Permission Manager
    participant LLM as LLM Integration
    participant Tools as Tool Executors
    participant Memory as Memory Backend
    participant Otel as OpenTelemetry

    alt INITIALIZATION PHASE (input event exists)
        Resumable->>Agent: execute(input event, context=null)
        Agent->>Otel: Start span (OpenInference AGENT kind)
        Agent->>Agent: Connect MCP client (if configured)
        
        rect rgb(200, 220, 240)
            Note over Agent,Context: Context Engineering Phase
            Agent->>Context: contextBuilder({ lifecycle: 'init', input, tools, span })
            Note over Context: Developer-defined function:<br/>Maps input event → System Prompt + Messages
            Context-->>Agent: { system: string, messages: AgentMessage[] }
            
            Agent->>Agent: Ensure all messages have seenCount
            Note over Agent: messages.map(m => ({<br/>  ...m,<br/>  seenCount: m.seenCount ?? 0<br/>}))
            
            alt No messages from context builder
                Agent->>Agent: Create default message from input data
                Note over Agent: [{<br/>  role: 'user',<br/>  content: { type: 'text', content: JSON.stringify(inputData) },<br/>  seenCount: 0<br/>}]
            end
        end
        
        rect rgb(255, 245, 230)
            Note over Agent,PermMgr: Permission Policy Initialization
            Agent->>Agent: Build permissionManagerContext
            Note over Agent: {<br/>  subject: input.subject,<br/>  accesscontrol: input.accesscontrol,<br/>  name: contracts.self.type<br/>}
            
            alt permissionPolicy handler defined
                Agent->>Agent: Evaluate permissionPolicy({ services, mcp, tools })
                Agent-->>Agent: permissionPolicy: string[] (tool names requiring auth)
            else No policy defined
                Agent->>Agent: permissionPolicy = []
            end
        end
        
        Agent->>CoreLoop: Start cognitive loop({ initLifecycle: 'init', system, messages, tools, permissionPolicy })
    else RESUME PHASE (service response received)
        Resumable->>Agent: execute(service response, context: AgentState)
        Agent->>Otel: Start span
        Agent->>Agent: Connect MCP client
        
        rect rgb(240, 220, 200)
            Note over Agent: State Restoration Phase
            Agent->>Agent: Retrieve persisted AgentState from context
            Note over Agent: Messages restored with their<br/>preserved seenCount values
            
            Agent->>Agent: Match service.parentid to awaitingToolCalls[toolUseId]
            Agent->>Agent: Populate tool result: awaitingToolCalls[toolUseId].data = service.data
            
            rect rgb(255, 245, 230)
                Note over Agent,PermMgr: Permission Response Handling
                
                alt Service is Permission Manager response
                    Agent->>PermMgr: set(permissionManagerContext, service)
                    Note over PermMgr: Update internal permission database<br/>with granted/denied authorizations
                    
                    alt Permission Manager returned error
                        Agent-->>Agent: throw Error('[Critical] Permission request failed')
                    end
                end
            end
            
            alt All tool results received
                Agent->>Agent: Append all tool results to message history
                loop For each tool result
                    alt Result is NOT from Permission Manager
                        Agent->>Agent: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result', toolUseId, content },<br/>  seenCount: 0<br/>})
                    else Result is from Permission Manager
                        Agent->>Agent: messages.push({<br/>  role: 'user',<br/>  content: { type: 'text', content: permission_response },<br/>  seenCount: 0<br/>})
                        Note over Agent: Permission responses wrapped as text<br/>rather than tool_result for LLM visibility
                    end
                end
            else Still waiting for other tool responses
                Agent->>Resumable: return { context: updatedState }
                Note over Resumable: Agent remains suspended—<br/>waiting for other in-flight service calls
            end
        end
        
        rect rgb(255, 245, 230)
            Note over Agent: Permission Context Restoration
            Agent->>Agent: Restore permissionManagerContext from state
            Note over Agent: {<br/>  subject: context.currentSubject,<br/>  accesscontrol: context.initEventAccessControl,<br/>  name: contracts.self.type<br/>}
            
            Agent->>Agent: Restore permissionPolicy from handler config
        end
        
        Agent->>CoreLoop: Start cognitive loop({ initLifecycle: 'tool_result', messages, permissionPolicy })
    end
    
    rect rgb(220, 240, 220)
        Note over CoreLoop,LLM: **ReAct Cognitive Loop** (Reason + Act)
        
        loop While toolInteractions.current < toolInteractions.max
            CoreLoop->>LLM: llm({ lifecycle, system, messages, tools, outputFormat })
            Note over LLM: LLM Integration receives messages<br/>with their current seenCount values.<br/>Provider-specific masking logic<br/>(e.g., media with seenCount > 0)
            
            LLM-->>CoreLoop: { type: 'tool_call' | 'text' | 'json', ... }
            
            CoreLoop->>CoreLoop: executionUnits += response.executionUnits
            CoreLoop->>CoreLoop: toolInteractions.current++
            
            rect rgb(255, 240, 245)
                Note over CoreLoop: **SeenCount Update Phase**
                
                loop For each message in messages
                    CoreLoop->>CoreLoop: messages[i].seenCount += 1
                end
                
                Note over CoreLoop: **Critical Mechanism:**<br/>All messages that just went to the LLM<br/>now have their view count incremented.<br/>This enables token optimization strategies<br/>in provider integrations (e.g., masking media)
            end
            
            alt Response Type: TOOL_CALL
                CoreLoop->>CoreLoop: prioritizeToolCalls(response.toolRequests, nameToToolMap)
                Note over CoreLoop: **Priority-Based Filtering:**<br/>Only execute highest-priority batch,<br/>silently drop lower-priority calls
                
                rect rgb(255, 250, 240)
                    Note over CoreLoop,PermMgr: **Permission Authorization Gate**
                    
                    CoreLoop->>CoreLoop: Filter tools requiring permission
                    Note over CoreLoop: toolsRequiringAuth = prioritizedToolCalls<br/>  .filter(tc => permissionPolicy.includes(tc.name))
                    
                    alt Tools requiring permission exist
                        CoreLoop->>PermMgr: get(permissionManagerContext, toolDefinitions)
                        Note over PermMgr: **Permission Check:**<br/>Queries internal state for each tool.<br/>Returns { toolName: boolean }
                        PermMgr-->>CoreLoop: toolPermissionMap: Record<string, boolean>
                    else No tools require permission
                        CoreLoop->>CoreLoop: toolPermissionMap = {}
                    end
                end
                
                rect rgb(240, 240, 200)
                    Note over CoreLoop,Tools: Tool Execution Strategy Selection
                    
                    loop For each prioritized tool call
                        CoreLoop->>CoreLoop: Create tool call message
                        Note over CoreLoop: messages.push({<br/>  role: 'assistant',<br/>  content: { type: 'tool_use', toolUseId, name, input },<br/>  seenCount: 1<br/>})<br/><br/>**SeenCount=1 because LLM generated it**
                        
                        alt Tool doesn't exist
                            CoreLoop->>CoreLoop: Push error message
                            Note over CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result', error },<br/>  seenCount: 0<br/>})
                        else Tool permission denied (toolPermissionMap[name] === false)
                            rect rgb(255, 230, 230)
                                Note over CoreLoop,PermMgr: **Authorization Blocked**
                                
                                CoreLoop->>CoreLoop: Collect blocked tool for permission request
                                Note over CoreLoop: toolsPendingPermission.push(toolDefinition)
                                
                                CoreLoop->>CoreLoop: Push blocking feedback message
                                Note over CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result',<br/>    toolUseId,<br/>    content: '[Critical] Tool blocked - permission required.<br/>             Request lodged, please retry after approval.' },<br/>  seenCount: 0<br/>})<br/><br/>**Explicit feedback to LLM:**<br/>Tool was blocked but permission is being requested
                            end
                        else Tool is MCP
                            CoreLoop->>Tools: mcp.invokeTool(name, arguments)
                            Tools-->>CoreLoop: result
                            CoreLoop->>CoreLoop: Queue MCP result
                            Note over CoreLoop: Result will be added with seenCount=0
                        else Tool is Internal
                            CoreLoop->>Tools: tool.fn(input, { otelInfo })
                            Tools-->>CoreLoop: result
                            CoreLoop->>CoreLoop: Queue internal result
                            Note over CoreLoop: Result will be added with seenCount=0
                        else Tool is Arvo Service
                            alt Schema validation fails
                                CoreLoop->>CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result', error },<br/>  seenCount: 0<br/>})
                            else Schema validation succeeds
                                CoreLoop->>CoreLoop: arvoToolCalls.push({ toolUseId, name, input })
                                Note over CoreLoop: **CRITICAL BRANCH:**<br/>Agent will suspend here
                            end
                        end
                    end
                    
                    loop For each MCP tool result
                        CoreLoop->>CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result', ... },<br/>  seenCount: 0<br/>})
                    end
                    
                    loop For each Internal tool result
                        CoreLoop->>CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'tool_result', ... },<br/>  seenCount: 0<br/>})
                    end
                    
                    Note over CoreLoop: **SeenCount Pattern:**<br/>- Assistant messages (tool calls): seenCount=1<br/>- User messages (tool results): seenCount=0
                end
                
                rect rgb(255, 250, 240)
                    Note over CoreLoop,PermMgr: **Permission Request Construction**
                    
                    alt toolsPendingPermission not empty AND permissionManager exists
                        CoreLoop->>PermMgr: requestBuilder(permissionManagerContext, toolsPendingPermission)
                        Note over PermMgr: **Build Permission Request:**<br/>Developer-defined logic creates event payload<br/>with context about blocked tools
                        PermMgr-->>CoreLoop: permissionRequestData (contract accepts schema)
                        
                        CoreLoop->>CoreLoop: Create permission request tool call
                        Note over CoreLoop: arvoToolCalls.push({<br/>  type: 'tool_use',<br/>  name: permissionManager.contract.accepts.type,<br/>  toolUseId: uuid(),<br/>  input: permissionRequestData<br/>})<br/><br/>**Permission request treated as Arvo service call**
                    end
                end
                
                alt Arvo service calls exist (including permission requests)
                    CoreLoop->>Otel: End span
                    CoreLoop-->>Agent: { messages, toolCalls: arvoToolCalls, toolInteractions, executionUnits }
                    
                    rect rgb(200, 240, 240)
                        Note over Agent,Memory: Suspension & Persistence Phase
                        
                        Agent->>Agent: Build AgentState for persistence
                        Note over Agent: {<br/>  initEventAccessControl,<br/>  currentSubject,<br/>  system,<br/>  messages, // WITH seenCount preserved per message<br/>  toolInteractions,<br/>  awaitingToolCalls,<br/>  totalExecutionUnits<br/>}
                        
                        Agent->>Resumable: return { context: AgentState, services: [...] }
                        Note over Resumable,Memory: ArvoResumable handles:<br/>1. Persisting context (with seenCount) to memory<br/>2. Emitting service call events<br/>   (including permission requests to configured domains)<br/>3. Suspending execution<br/><br/>**Permission requests routed via domains<br/>(e.g., 'human.interaction')**
                    end
                else No Arvo service calls (only sync tools executed)
                    CoreLoop->>CoreLoop: lifecycle = 'tool_result'
                    Note over CoreLoop: Continue iteration with<br/>updated message history<br/>(all seenCount already incremented)<br/><br/>**LLM will see blocked tool feedback<br/>and may retry after seeing approval**
                end
                
            else Response Type: TEXT or JSON
                rect rgb(240, 200, 240)
                    Note over CoreLoop: Output Validation & Self-Correction Phase
                    
                    CoreLoop->>CoreLoop: outputBuilder({ ...response, outputFormat, span })
                    Note over CoreLoop: Developer-defined function:<br/>Maps LLM output → Contract-compliant schema
                    
                    alt Output validation fails
                        CoreLoop->>CoreLoop: messages.push({<br/>  role: 'assistant',<br/>  content: { type: 'text', content: response.content },<br/>  seenCount: 1<br/>})
                        Note over CoreLoop: **SeenCount=1:** LLM generated this response
                        
                        CoreLoop->>CoreLoop: messages.push({<br/>  role: 'user',<br/>  content: { type: 'text', content: error },<br/>  seenCount: 0<br/>})
                        Note over CoreLoop: **SeenCount=0:** Error feedback not seen yet
                        
                        CoreLoop->>CoreLoop: lifecycle = 'output_error_feedback'
                        Note over CoreLoop: **Self-Correction Loop:**<br/>Feed validation error back to LLM.<br/>Next iteration will increment seenCount
                    else Output validation succeeds
                        CoreLoop->>CoreLoop: messages.push({<br/>  role: 'assistant',<br/>  content: { type: 'text', content: JSON.stringify(data) },<br/>  seenCount: 1<br/>})
                        Note over CoreLoop: **SeenCount=1:** Final response generated by LLM
                        
                        CoreLoop->>Otel: End span
                        CoreLoop-->>Agent: { messages, output: validatedData, toolInteractions, executionUnits }
                        
                        Agent->>Agent: Build final AgentState
                        Note over Agent: Messages persisted with final seenCount values
                        
                        Agent->>Resumable: return { context: AgentState, output: { __executionunits, ...data } }
                        Note over Resumable: ArvoResumable emits<br/>completion event to broker
                    end
                end
            end
        end
        
        alt Tool interaction quota exhausted
            CoreLoop-->>Agent: throw Error('Tool calls exhausted max quota')
            Agent->>Resumable: Error propagates (system error event emitted)
        end
    end
    
    Agent->>Agent: Disconnect MCP client (finally block)
```
