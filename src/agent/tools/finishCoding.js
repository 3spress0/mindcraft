/**
 * FinishCoding Tool - Allows AI to finish the current coding session and return to normal mode
 */
export class FinishCodingTool {
    static description = 'Finish the current coding session and return to normal mode. Use this tool when you have completed all the required coding tasks and want to provide a summary of what was accomplished during the coding session.\n\nUsage:\n- Call this tool only when you have finished all coding tasks\n- Provide a comprehensive summary of what was accomplished\n- This will gracefully exit the coding mode and return control to the main agent\n- The summary will be returned as the result of the newAction command';
    static inputSchema = {
        type: "object",
        properties: {
            summary: { 
                type: "string", 
                description: "Comprehensive summary of what was accomplished during the coding session. Include: tasks completed, files created/modified, any issues encountered, and final status." 
            }
        },
        required: ["summary"]
    };

    constructor(agent = null) {
        this.agent = agent;
    }

    /**
     * Execute the FinishCoding tool
     * @param {Object} params - Tool parameters
     * @param {string} params.summary - Summary of what was accomplished during the coding session
     * @returns {Object} Tool execution result
     */
    execute(params) {
        const { summary } = params;

        if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
            return {
                success: false,
                error: 'Summary parameter is required and must be a non-empty string'
            };
        }

        try {
            console.log('\x1b[36m[FinishCoding]\x1b[0m Coding session finish requested with summary:', summary.trim());
            
            return {
                success: true,
                message: `Coding session will be finished. Summary: ${summary.trim()}`,
                action: 'finish_coding'  // 添加特殊标识
            };
        } catch (error) {
            return {
                success: false,
                error: `Failed to finish coding session: ${error.message}`
            };
        }
    }
}
