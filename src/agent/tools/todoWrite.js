import fs from 'fs';
import path from 'path';
import process from 'process';

/**
 * TodoWrite Tool - Creates and manages structured task lists for coding sessions
 */
export class TodoWriteTool {
    static description = 'Create or update TODO list for task planning and tracking progress';
    static inputSchema = {
        type: "object",
        properties: {
            todos: {
                type: "array",
                description: "Array of todo items with content, status, and id",
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "Todo item description" },
                        status: { 
                            type: "string", 
                            enum: ["pending", "in_progress", "completed"],
                            description: "Current status of the todo item"
                        },
                        id: { type: "string", description: "Unique identifier for the todo item" }
                    },
                    required: ["content", "status", "id"]
                }
            }
        },
        required: ["todos"]
    };

    constructor(agent = null) {
        this.name = 'TodoWrite';
        this.agent = agent;
    }

    /**
     * Execute the TodoWrite tool
     * @param {Object} params - Tool parameters
     * @returns {Object} Execution result
     */
    execute(params) {
        let message = '';
        try {
            // Validate input
            if (!params.todos || !Array.isArray(params.todos)) {
                return {
                    success: false,
                    message: "todos parameter must be an array",
                    file_path: this.getTodoFilePath()
                };
            }

            // Validate each todo item
            for (const todo of params.todos) {
                if (!todo.content || !todo.status || !todo.id) {
                    return {
                        success: false,
                        message: "Each todo must have content, status, and id",
                        file_path: this.getTodoFilePath()
                    };
                }

                if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
                    return {
                        success: false,
                        message: `Invalid status: ${todo.status}. Must be pending, in_progress, or completed`,
                        file_path: this.getTodoFilePath()
                    };
                }
            }

            // Check for multiple in_progress tasks
            const inProgressTasks = params.todos.filter(todo => todo.status === "in_progress");
            if (inProgressTasks.length > 1) {
                return {
                    success: false,
                    message: "Only one task can be in_progress at a time",
                    file_path: this.getTodoFilePath()
                };
            }

            // Generate markdown content
            const markdownContent = this.generateMarkdown(params.todos);

            // Determine file path
            const todoFilePath = this.getTodoFilePath();

            // Write to file
            const dir = path.dirname(todoFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(todoFilePath, markdownContent, 'utf8');

            // Generate summary
            const summary = this.generateSummary(params.todos);
            message = `TodoList updated successfully: ${summary}`;

            return {
                success: true,
                message: message,
                file_path: todoFilePath
            };

        } catch (error) {
            return {
                success: false,
                message: `TodoWrite execution failed: ${error.message}`,
                file_path: this.getTodoFilePath()
            };
        }
    }

    /**
     * Generate markdown content from todos
     * @param {Array} todos - Array of todo items
     * @returns {string} Markdown content
     */
    generateMarkdown(todos) {
        let content = "# TODO LIST\n\n";
        
        const pendingTasks = todos.filter(todo => todo.status === "pending");
        const inProgressTasks = todos.filter(todo => todo.status === "in_progress");
        const completedTasks = todos.filter(todo => todo.status === "completed");

        if (inProgressTasks.length > 0) {
            content += "## In Progress\n";
            inProgressTasks.forEach(todo => {
                content += `- [x] **${todo.content}** (ID: ${todo.id})\n`;
            });
            content += "\n";
        }

        if (pendingTasks.length > 0) {
            content += "## Pending\n";
            pendingTasks.forEach(todo => {
                content += `- [ ] ${todo.content} (ID: ${todo.id})\n`;
            });
            content += "\n";
        }

        if (completedTasks.length > 0) {
            content += "## Completed\n";
            completedTasks.forEach(todo => {
                content += `- [x] ~~${todo.content}~~ (ID: ${todo.id})\n`;
            });
            content += "\n";
        }

        content += `\n---\n*Last updated: ${new Date().toISOString()}*\n`;
        
        return content;
    }

    /**
     * Generate summary of todo list changes
     * @param {Array} todos - Array of todo items
     * @returns {string} Summary text
     */
    generateSummary(todos) {
        const pendingCount = todos.filter(todo => todo.status === "pending").length;
        const inProgressCount = todos.filter(todo => todo.status === "in_progress").length;
        const completedCount = todos.filter(todo => todo.status === "completed").length;

        return `${pendingCount} pending, ${inProgressCount} in progress, ${completedCount} completed`;
    }


    getTodoFilePath() {
        const projectRoot = process.cwd();
        if (this.agent && this.agent.name) {
            return path.join(projectRoot, 'bots', this.agent.name, 'TODOLIST.md');
        }
        return path.join(projectRoot, 'bots', 'default', 'TODOLIST.md');
    }
}

export default TodoWriteTool;
